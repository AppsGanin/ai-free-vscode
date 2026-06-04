import * as vscode from "vscode";
import { log } from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import { vsCodeMessageToAI } from "../providers/types";

// Небольшая буферизация стрима для более плавного отображения в чате
// и возможности "подсмотреть" ближайшие символы перед рендером.
const STREAM_BUFFER_CHARS = 360;
const UI_EMIT_CHUNK_CHARS = 80;
const UI_EMIT_DELAY_MS = 12;
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
    const isAuth = await this.provider.isAuthenticated(this.secrets);
    if (!isAuth) {
      // Возвращаем пустой список пока не авторизован,
      // после логина onDidAuthChange обновит список
      return [];
    }

    return this.provider.getModels().map((model) => ({
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

    log(
      `[${this.provider.id}] chat request model=${model.id} messages=${messages.length} user=${userCount} assistant=${assistantCount} system=${systemCount} tools=${toolCount} toolMode=${mappedToolMode}`,
    );

    const stream = this.provider.sendMessageStream(
      {
        model: model.id,
        messages: aiMessages,
        tools: tools?.length ? tools : undefined,
        toolMode: mappedToolMode,
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
    sanitized = sanitized.replace(
      /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g,
      " ",
    );
    sanitized = sanitized.replace(
      /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{.*\}\s*\}\s*$/gim,
      "\n",
    );

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
    // Простая оценка: ~4 символа на токен
    const str =
      typeof text === "string"
        ? text
        : text.content
            .map((p) =>
              typeof p === "string"
                ? p
                : "value" in p
                  ? String((p as { value: unknown }).value)
                  : "",
            )
            .join("");
    return Math.ceil(str.length / 4);
  }

  dispose(): void {
    this._onDidChangeChatInformation.dispose();
  }
}
