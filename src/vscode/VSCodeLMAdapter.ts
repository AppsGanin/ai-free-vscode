import * as vscode from "vscode";
import { log } from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import {
  looksLikeToolCallStart,
  parseToolCallsFromText,
  stripInlineToolCallJson,
} from "../providers/common/ToolCalling";
import { vsCodeMessageToAI } from "../providers/types";

// Небольшая буферизация стрима для более плавного отображения в чате
// и возможности "подсмотреть" ближайшие символы перед рендером.
const STREAM_BUFFER_CHARS = 360;
const UI_EMIT_CHUNK_CHARS = 80;
const UI_EMIT_DELAY_MS = 12;
// Накладные расходы на структуру одного сообщения (роль/разделители) в токенах.
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Грубая, но более честная, чем chars/4, оценка числа токенов.
 *
 * BPE-токенайзеры Qwen/DeepSeek дают для латиницы ~4 символа на токен, а для
 * кириллицы/CJK — гораздо меньше (часто ~1.5 символа на токен). Простое
 * `length / 4` сильно занижало контекст для не-латинского текста.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      ascii++;
    } else {
      other++;
    }
  }
  return Math.ceil(ascii / 4 + other / 1.5);
}

/**
 * Извлекает текст из части сообщения VS Code для оценки токенов.
 * Учитывает text-части, а также tool call/result (их содержимое тоже идёт в
 * контекст), чтобы не занижать счётчик.
 */
function partToCountableText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  if (typeof p.value === "string") return p.value; // LanguageModelTextPart
  if (typeof p.name === "string" && "input" in p) {
    // LanguageModelToolCallPart
    return `${p.name} ${safeStringify(p.input)}`;
  }
  if ("content" in p) {
    // LanguageModelToolResultPart
    const content = p.content;
    if (Array.isArray(content)) {
      return content.map(partToCountableText).join(" ");
    }
    return safeStringify(content);
  }
  return "";
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * Адаптер: оборачивает BaseAIProvider в vscode.LanguageModelChatProvider.
 * Один экземпляр на каждый зарегистрированный провайдер.
 */
export class VSCodeLMAdapter implements vscode.LanguageModelChatProvider {
  private readonly _onDidChangeChatInformation =
    new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> =
    this._onDidChangeChatInformation.event;

  constructor(
    private readonly provider: BaseAIProvider,
    private readonly secrets: vscode.SecretStorage,
  ) {
    // Когда провайдер сообщает о смене авторизации — уведомляем VS Code обновить список моделей
    provider.onDidAuthChange(() => {
      this._onDidChangeChatInformation.fire();
    });
  }

  // ─── LanguageModelChatProvider interface ──────────────────────────────────

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Берём только модели авторизованных (под-)провайдеров: иначе в picker'е
    // появляются модели, в которые пользователь не вошёл, и запрос падает.
    const availableModels = await this.provider.getAvailableModels(
      this.secrets,
    );
    if (availableModels.length === 0) {
      // Возвращаем пустой список пока не авторизован,
      // после логина onDidAuthChange обновит список
      return [];
    }

    return availableModels
      .filter((model) => model.capabilities.chat !== false)
      .map((model) => ({
        id: model.id,
        name: model.name,
        family: model.family,
        version: model.version ?? "1.0.0",
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: {
          toolCalling: model.capabilities.toolCalling ?? false,
          imageInput: model.capabilities.imageInput ?? false,
        },
      }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());

    const toolCount = options.tools?.length ?? 0;

    // Конвертируем сообщения VS Code → универсальный формат
    const aiMessages = messages.map((m) => vsCodeMessageToAI(m));
    const systemCount = aiMessages.filter((m) => m.role === "system").length;
    const userCount = aiMessages.filter((m) => m.role === "user").length;
    const assistantCount = aiMessages.filter(
      (m) => m.role === "assistant",
    ).length;

    // Конвертируем инструменты VS Code → универсальный формат
    const tools = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    const rawToolMode = String(options.toolMode ?? "").toLowerCase();
    const mappedToolMode: "auto" | "required" | "none" = rawToolMode.includes(
      "required",
    )
      ? "required"
      : rawToolMode.includes("none")
        ? "none"
        : "auto";
    const protectFromRawToolProtocol =
      mappedToolMode !== "none" && toolCount > 0;

    // Вызывающая сторона может принудительно задать режим thinking через
    // modelOptions (например коммиты/inline-подсказки отключают reasoning).
    const rawThinking = (
      options.modelOptions as { thinkingMode?: unknown } | undefined
    )?.thinkingMode;
    const thinkingMode: "auto" | "on" | "off" | undefined =
      rawThinking === "on" || rawThinking === "off" || rawThinking === "auto"
        ? rawThinking
        : undefined;

    log(
      `[${this.provider.id}] chat request model=${model.id} messages=${messages.length} user=${userCount} assistant=${assistantCount} system=${systemCount} tools=${toolCount} toolMode=${mappedToolMode}`,
    );

    const stream = this.provider.sendMessageStream(
      {
        model: model.id,
        messages: aiMessages,
        tools: tools?.length ? tools : undefined,
        toolMode: mappedToolMode,
        thinkingMode,
        abortSignal: abortController.signal,
      },
      this.secrets,
    );

    // Накапливаем tool call аргументы (приходят по частям)
    const pendingToolCalls = new Map<string, { name: string; args: string }>();
    let textChunks = 0;
    let emittedToolCalls = 0;
    let generatedChars = 0;
    let thinkingChunks = 0;
    let gotProviderUsage = false;

    let textBuffer = "";
    let thinkingBuffer = "";
    // Полный сырой text-поток (до санитайза) — для восстановления tool_call,
    // если он утёк в текстовый канал (например очень большой вызов, который не
    // удержал holdback провайдера).
    let rawTextAll = "";
    // Полный thinking-поток — для восстановления tool_call, если модель увела
    // его в reasoning-канал вместо канала ответа (thinking + tools).
    let thinkingAll = "";

    const ThinkingPartCtor = (
      vscode as unknown as {
        LanguageModelThinkingPart?: new (
          value: string,
        ) => vscode.LanguageModelResponsePart;
      }
    ).LanguageModelThinkingPart;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const emitTextSmooth = async (text: string) => {
      if (!text) return;
      for (let i = 0; i < text.length; i += UI_EMIT_CHUNK_CHARS) {
        const part = text.slice(i, i + UI_EMIT_CHUNK_CHARS);
        progress.report(new vscode.LanguageModelTextPart(part));
        // Даём UI шанс прорисовать постепенный вывод
        await sleep(UI_EMIT_DELAY_MS);
      }
    };

    const emitThinkingSmooth = async (text: string) => {
      if (!text) return;
      if (ThinkingPartCtor) {
        for (let i = 0; i < text.length; i += UI_EMIT_CHUNK_CHARS) {
          const part = text.slice(i, i + UI_EMIT_CHUNK_CHARS);
          progress.report(new ThinkingPartCtor(part));
          await sleep(UI_EMIT_DELAY_MS);
        }
        return;
      }

      // Fallback: ThinkingPart недоступен
      const quoted = text.replace(/\n/g, "\n> ");
      await emitTextSmooth(`> 💭 **Thinking**\n> ${quoted}\n`);
    };

    const flushTextBuffer = async () => {
      if (!textBuffer) return;
      await emitTextSmooth(textBuffer);
      textBuffer = "";
    };

    const flushThinkingBuffer = async () => {
      if (!thinkingBuffer) return;
      await emitThinkingSmooth(thinkingBuffer);
      thinkingBuffer = "";
    };

    const shouldFlushBuffer = (buf: string): boolean => {
      if (buf.length >= STREAM_BUFFER_CHARS) return true;
      // Предпочитаем отдавать по границе фразы / новой строки.
      return /\n$|[.!?…]\s$/.test(buf);
    };

    const promptChars = aiMessages
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : m.content
              .map((p) => (p.type === "text" ? p.text : "[image]"))
              .join("\n"),
      )
      .join("\n\n").length;

    try {
      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          log(`[${this.provider.id}] chat cancelled`);
          break;
        }

        if (chunk.type === "text") {
          rawTextAll += chunk.content;
          const safeText = this.sanitizeRawToolProtocolText(
            chunk.content,
            protectFromRawToolProtocol,
          );
          if (!safeText) {
            continue;
          }

          textChunks++;
          generatedChars += safeText.length;
          textBuffer += safeText;
          if (shouldFlushBuffer(textBuffer)) {
            await flushTextBuffer();
          }
        } else if (chunk.type === "thinking") {
          thinkingChunks++;
          generatedChars += chunk.content.length;
          thinkingBuffer += chunk.content;
          thinkingAll += chunk.content;
          if (shouldFlushBuffer(thinkingBuffer)) {
            await flushThinkingBuffer();
          }
        } else if (chunk.type === "tool_call") {
          // Перед tool call сбрасываем любые накопленные части текста/мышления,
          // чтобы сохранить корректный порядок отображения.
          await flushThinkingBuffer();
          await flushTextBuffer();

          const existing = pendingToolCalls.get(chunk.callId);
          const mergedArgs = existing
            ? `${existing.args}${chunk.argumentsPart}`
            : chunk.argumentsPart;
          const name = existing?.name ?? chunk.name;

          // Пытаемся эмитить вызов сразу, как только args становятся валидным JSON.
          const parsedArgs = this.tryParseJsonObject(mergedArgs);
          if (parsedArgs) {
            const normalizedArgs = this.normalizeToolArguments(
              name,
              parsedArgs,
            );
            progress.report(
              new vscode.LanguageModelToolCallPart(
                chunk.callId,
                name,
                normalizedArgs,
              ),
            );
            emittedToolCalls++;
            pendingToolCalls.delete(chunk.callId);
          } else {
            pendingToolCalls.set(chunk.callId, {
              name,
              args: mergedArgs,
            });
          }
        } else if (chunk.type === "usage") {
          await flushThinkingBuffer();
          await flushTextBuffer();
          gotProviderUsage = true;
          this.reportUsage(
            progress,
            chunk.promptTokens,
            chunk.completionTokens,
          );
        }
      }
    } catch (err) {
      await flushThinkingBuffer();
      await flushTextBuffer();
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "object" &&
              err !== null &&
              typeof (err as { message?: unknown }).message === "string"
            ? String((err as { message?: unknown }).message)
            : String(err);
      log(`[${this.provider.id}] chat error: ${msg}`);
      throw err;
    }

    // Финальный сброс буферов после завершения стрима
    await flushThinkingBuffer();
    await flushTextBuffer();

    log(
      `[${this.provider.id}] chat done textChunks=${textChunks} thinkingChunks=${thinkingChunks} toolCalls=${emittedToolCalls} pendingToolCalls=${pendingToolCalls.size}`,
    );

    // Репортируем оставшиеся незавершённые tool calls
    for (const [callId, call] of pendingToolCalls) {
      const args = this.tryParseJsonObject(call.args) ?? {};
      const normalizedArgs = this.normalizeToolArguments(call.name, args);
      progress.report(
        new vscode.LanguageModelToolCallPart(callId, call.name, normalizedArgs),
      );
      emittedToolCalls++;
    }

    if (pendingToolCalls.size > 0) {
      log(
        `[${this.provider.id}] flushed pending tool calls, totalEmitted=${emittedToolCalls}`,
      );
    }

    // Восстановление tool_call, если он не пришёл структурно, но «утёк» в
    // текстовый или thinking-канал (большой вызов мимо holdback провайдера, или
    // reasoning при thinking+tools). Достаём из накопленных буферов.
    if (protectFromRawToolProtocol && emittedToolCalls === 0) {
      for (const [source, buffer] of [
        ["text", rawTextAll],
        ["thinking", thinkingAll],
      ] as const) {
        if (!looksLikeToolCallStart(buffer)) {
          continue;
        }
        let recovered = 0;
        for (const tc of parseToolCallsFromText(buffer)) {
          if (tc.type !== "tool_call") {
            continue;
          }
          const args = this.tryParseJsonObject(tc.argumentsPart) ?? {};
          const normalizedArgs = this.normalizeToolArguments(tc.name, args);
          progress.report(
            new vscode.LanguageModelToolCallPart(
              tc.callId,
              tc.name,
              normalizedArgs,
            ),
          );
          emittedToolCalls++;
          recovered++;
        }
        if (recovered > 0) {
          log(
            `[${this.provider.id}] recovered ${recovered} tool_call(s) from ${source} channel`,
          );
          break;
        }
      }
    }

    // Фолбэк usage: если провайдер не прислал фактические токены,
    // отправляем оценку (~4 chars/token), чтобы VS Code показал индикатор контекста.
    if (!gotProviderUsage) {
      const estimatedPromptTokens = Math.ceil(promptChars / 4);
      const estimatedCompletionTokens = Math.ceil(generatedChars / 4);
      this.reportUsage(
        progress,
        estimatedPromptTokens,
        estimatedCompletionTokens,
      );
    }
  }

  private reportUsage(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    promptTokens: number,
    completionTokens: number,
  ): void {
    if (!vscode.LanguageModelDataPart) {
      return;
    }

    const usage = {
      prompt_tokens: Math.max(0, Math.floor(promptTokens)),
      completion_tokens: Math.max(0, Math.floor(completionTokens)),
      total_tokens:
        Math.max(0, Math.floor(promptTokens)) +
        Math.max(0, Math.floor(completionTokens)),
    };

    progress.report(
      new vscode.LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(usage)),
        "usage",
      ),
    );
  }

  private tryParseJsonObject(
    text: string,
  ): Record<string, unknown> | undefined {
    const raw = (text ?? "").trim();
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return undefined;
    }
  }

  private normalizeToolArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (toolName !== "read_file") {
      return args;
    }

    const normalized: Record<string, unknown> = { ...args };

    const toFiniteNumber = (value: unknown): number | undefined => {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return undefined;
    };

    const rawStart = toFiniteNumber(normalized.startLine);
    const rawEnd = toFiniteNumber(normalized.endLine);

    const startLine = Math.max(1, Math.floor(rawStart ?? 1));
    let endLine = rawEnd !== undefined ? Math.floor(rawEnd) : startLine + 1999;

    // Защита от некорректных вызовов вроде endLine=0.
    if (endLine < startLine) {
      endLine = startLine + 1999;
    }

    normalized.startLine = startLine;
    normalized.endLine = endLine;

    return normalized;
  }

  private sanitizeRawToolProtocolText(text: string, enabled: boolean): string {
    if (!enabled || !text) {
      return text;
    }

    let sanitized = text;

    sanitized = sanitized.replace(/```tool_call[\s\S]*?```/gi, "\n\n");
    sanitized = sanitized.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "\n\n");
    // Сбалансированное удаление inline JSON tool-call (учитывает вложенные `}`
    // в больших строковых аргументах — regex это не вытягивал).
    sanitized = stripInlineToolCallJson(sanitized);

    sanitized = sanitized.replace(/^\s*tool_call\s*$/gim, "\n");
    sanitized = sanitized.replace(
      /^\s*User:\s*\[Tool result id=[^\]]+\][\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|\Z)/gim,
      "\n",
    );
    sanitized = sanitized.replace(
      /^\s*(?:User:\s*)?\[(?:Tool result id=[^\]]+|toolu_[^\]]+)\][\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|\Z)/gim,
      "\n",
    );
    sanitized = sanitized.replace(
      /^\s*\{\s*"status"\s*:\s*"success"[\s\S]*?"type"\s*:\s*"[^\"]*_result"[\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|\Z)/gim,
      "\n",
    );
    sanitized = sanitized.replace(/^\s*Tool:\s.*$/gim, "\n");
    sanitized = sanitized.replace(/^\s*User:\s*Tool result:.*$/gim, "\n");
    sanitized = sanitized.replace(/^\s*User:\s*\[call_[^\]]+\].*$/gim, "\n");
    sanitized = sanitized.replace(
      /^\s*\/Users\/[^\n]*chat-session-resources[^\n]*$/gim,
      "\n",
    );
    sanitized = sanitized.replace(/^\s*Assistant:\s?/gim, "");

    // Убираем только полностью пустые fenced-блоки, не трогая нормальные
    // markdown code fences с содержимым.
    sanitized = sanitized.replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n");

    // ВНИМАНИЕ: не схлопываем горизонтальные пробелы (` `/`\t`). Санитайзер
    // вызывается на каждом частичном чанке стрима, и `/[ \t]{2,}/ → " "` съедал
    // отступы кода и выровненный текст — это выглядело как "пропавшие символы".
    sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

    return sanitized;
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokens(text);
    }

    const str = text.content.map(partToCountableText).join("\n");
    return estimateTokens(str) + PER_MESSAGE_TOKEN_OVERHEAD;
  }

  dispose(): void {
    this._onDidChangeChatInformation.dispose();
  }
}
