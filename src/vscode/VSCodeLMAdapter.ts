import * as vscode from "vscode";
import { type ScopedLogger, createLogger, errToString } from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import {
  looksLikeToolCallStart,
  parseToolCallsFromText,
  stripToolCallBlocks,
  summarizeToolCalls,
} from "../providers/common/ToolCalling";
import type { AIMessage, AIStreamChunk } from "../providers/types";
import { vsCodeMessageToAI } from "../providers/types";

// Light buffering: smoother rendering, and a chance to look ahead before
// committing characters to the chat.
const STREAM_BUFFER_CHARS = 360;
const UI_EMIT_CHUNK_CHARS = 80;
const UI_EMIT_DELAY_MS = 12;
// Role and separator overhead of a single message, in tokens.
const PER_MESSAGE_TOKEN_OVERHEAD = 4;

const ThinkingPartCtor = (
  vscode as unknown as {
    LanguageModelThinkingPart?: new (
      value: string,
    ) => vscode.LanguageModelResponsePart;
  }
).LanguageModelThinkingPart;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Rough but honest token estimate. BPE tokenizers give ~4 chars per token for
 * latin text and far fewer (~1.5) for Cyrillic/CJK, so a plain `length / 4`
 * badly underestimated non-latin context.
 */
function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return Math.ceil(ascii / 4 + (text.length - ascii) / 1.5);
}

/** Text of a VS Code message part, including tool calls/results — all context. */
function partToCountableText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";

  const p = part as Record<string, unknown>;
  if (typeof p.value === "string") return p.value; // LanguageModelTextPart
  if (typeof p.name === "string" && "input" in p) {
    return `${p.name} ${safeStringify(p.input)}`; // LanguageModelToolCallPart
  }
  if ("content" in p) {
    // LanguageModelToolResultPart
    return Array.isArray(p.content)
      ? p.content.map(partToCountableText).join(" ")
      : safeStringify(p.content);
  }
  return "";
}

function messageChars(message: AIMessage): number {
  const content =
    typeof message.content === "string"
      ? message.content.length
      : message.content.reduce(
          (sum, part) => sum + (part.type === "text" ? part.text.length : 9),
          0,
        );

  // In native mode the tool traffic lives outside `content`; leaving it out
  // made the logged prompt size stop growing across an agent loop.
  const calls = (message.toolCalls ?? []).reduce(
    (sum, call) => sum + call.name.length + call.arguments.length,
    0,
  );
  const results = (message.toolResults ?? []).reduce(
    (sum, result) => sum + result.content.length,
    0,
  );

  return content + calls + results;
}

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Buffers a channel and releases it in small slices, so the UI can paint. */
class SmoothStream {
  private buffer = "";

  constructor(
    private readonly report: (part: string) => void,
    private readonly transform: (text: string) => string = (t) => t,
  ) {}

  async push(text: string): Promise<void> {
    this.buffer += text;
    // Prefer to flush on a phrase or line boundary.
    if (
      this.buffer.length >= STREAM_BUFFER_CHARS ||
      /\n$|[.!?…]\s$/.test(this.buffer)
    ) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.buffer) return;
    const text = this.transform(this.buffer);
    this.buffer = "";
    for (let i = 0; i < text.length; i += UI_EMIT_CHUNK_CHARS) {
      this.report(text.slice(i, i + UI_EMIT_CHUNK_CHARS));
      await sleep(UI_EMIT_DELAY_MS);
    }
  }
}

/** Wraps a BaseAIProvider as a vscode.LanguageModelChatProvider. */
export class VSCodeLMAdapter implements vscode.LanguageModelChatProvider {
  private readonly _onDidChangeChatInformation =
    new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> =
    this._onDidChangeChatInformation.event;

  private readonly log: ScopedLogger;

  constructor(
    private readonly provider: BaseAIProvider,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.log = createLogger(provider.id);
    provider.onDidAuthChange(() => this._onDidChangeChatInformation.fire());
  }

  /** Only models of signed-in sub-providers; others would fail on first use. */
  async provideLanguageModelChatInformation(): Promise<
    vscode.LanguageModelChatInformation[]
  > {
    const models = await this.provider.getAvailableModels(this.secrets);
    return models
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

    // Backends with a real tools API get the calls and results structured;
    // the web ones need them inlined into the transcript.
    const nativeTools = this.provider.supportsNativeToolCalls(model.id);
    const aiMessages = messages.map((message) =>
      vsCodeMessageToAI(message, { nativeTools }),
    );
    const tools = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema ?? {}) as Record<string, unknown>,
    }));

    const rawToolMode = String(options.toolMode ?? "").toLowerCase();
    const toolMode: "auto" | "required" | "none" = rawToolMode.includes(
      "required",
    )
      ? "required"
      : rawToolMode.includes("none")
        ? "none"
        : "auto";
    const toolsExpected = toolMode !== "none" && (tools?.length ?? 0) > 0;
    // Only the prompt-based protocol needs its markers scrubbed out of the
    // text and recovered from it; a native backend emits calls structurally,
    // and scrubbing would eat legitimate output instead.
    const promptToolProtocol = toolsExpected && !nativeTools;

    // Callers can force the thinking mode through modelOptions (commits and
    // inline suggestions turn reasoning off).
    const rawThinking = (options.modelOptions as { thinkingMode?: unknown })
      ?.thinkingMode;
    const thinkingMode =
      rawThinking === "on" || rawThinking === "off" || rawThinking === "auto"
        ? rawThinking
        : undefined;

    const promptChars = aiMessages.reduce((sum, m) => sum + messageChars(m), 0);
    const roles = aiMessages.reduce<Record<string, number>>((acc, m) => {
      acc[m.role] = (acc[m.role] ?? 0) + 1;
      return acc;
    }, {});
    const startedAt = Date.now();

    this.log.info(
      `chat request model=${model.id} messages=${messages.length} (${
        Object.entries(roles)
          .map(([role, n]) => `${role}=${n}`)
          .join(" ") || "none"
      }) promptChars=${promptChars} tools=${tools?.length ?? 0} toolMode=${toolMode} thinkingMode=${thinkingMode ?? "auto"}`,
    );

    const stream = this.provider.sendMessageStream(
      {
        model: model.id,
        messages: aiMessages,
        tools: tools?.length ? tools : undefined,
        toolMode,
        thinkingMode,
        abortSignal: abortController.signal,
      },
      this.secrets,
    );

    const text = new SmoothStream((part) =>
      progress.report(new vscode.LanguageModelTextPart(part)),
    );
    const thinking = ThinkingPartCtor
      ? new SmoothStream((part) => progress.report(new ThinkingPartCtor(part)))
      : new SmoothStream(
          (part) => progress.report(new vscode.LanguageModelTextPart(part)),
          (raw) => `> 💭 **Thinking**\n> ${raw.replace(/\n/g, "\n> ")}\n`,
        );
    const flushAll = async () => {
      await thinking.flush();
      await text.flush();
    };

    // Tool call arguments arrive in pieces, keyed by call id.
    const pendingToolCalls = new Map<string, { name: string; args: string }>();
    const emitted: AIStreamChunk[] = [];
    let textChars = 0;
    let thinkingChars = 0;
    let gotProviderUsage = false;
    // Full raw streams, used to recover a tool call that leaked into the text or
    // reasoning channel instead of arriving structurally.
    let rawTextAll = "";
    let thinkingAll = "";

    const emitToolCall = (callId: string, name: string, args: string) => {
      // Log what VS Code actually receives, not the raw text: normalization
      // repairs things like read_file's endLine=0.
      const input = normalizeToolArguments(
        name,
        tryParseJsonObject(args) ?? {},
      );
      progress.report(
        new vscode.LanguageModelToolCallPart(callId, name, input),
      );
      emitted.push({ type: "tool_call", callId, name, argumentsPart: args });
      this.log.debug(
        `tool_call #${emitted.length} ${name} ${JSON.stringify(input).slice(0, 300)}`,
      );
    };

    try {
      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          this.log.info(`chat cancelled after ${Date.now() - startedAt}ms`);
          break;
        }

        if (chunk.type === "text") {
          rawTextAll += chunk.content;
          const safe = sanitizeToolProtocol(chunk.content, promptToolProtocol);
          if (!safe) continue;
          textChars += safe.length;
          await text.push(safe);
        } else if (chunk.type === "thinking") {
          thinkingChars += chunk.content.length;
          thinkingAll += chunk.content;
          await thinking.push(chunk.content);
        } else if (chunk.type === "tool_call") {
          // Flush pending text so the display order stays correct.
          await flushAll();

          const existing = pendingToolCalls.get(chunk.callId);
          const name = existing?.name ?? chunk.name;
          const args = (existing?.args ?? "") + chunk.argumentsPart;

          // Emit as soon as the arguments become valid JSON.
          if (tryParseJsonObject(args)) {
            emitToolCall(chunk.callId, name, args);
            pendingToolCalls.delete(chunk.callId);
          } else {
            pendingToolCalls.set(chunk.callId, { name, args });
          }
        } else if (chunk.type === "usage") {
          await flushAll();
          gotProviderUsage = true;
          this.log.debug(
            `provider usage prompt=${chunk.promptTokens} completion=${chunk.completionTokens}`,
          );
          this.reportUsage(
            progress,
            chunk.promptTokens,
            chunk.completionTokens,
          );
        }
      }
    } catch (err) {
      await flushAll();
      this.log.error(
        `chat error after ${Date.now() - startedAt}ms (text=${textChars} thinking=${thinkingChars} toolCalls=${emitted.length}): ${errToString(err)}`,
      );
      throw err;
    }

    await flushAll();

    for (const [callId, call] of pendingToolCalls) {
      this.log.debug(
        `flushing tool_call with incomplete arguments: ${call.name}`,
      );
      emitToolCall(callId, call.name, call.args);
    }

    // Nothing structural arrived, but a call may have leaked into another
    // channel (oversized call past the provider holdback, or thinking+tools).
    if (promptToolProtocol && emitted.length === 0) {
      for (const [source, buffer] of [
        ["text", rawTextAll],
        ["thinking", thinkingAll],
      ] as const) {
        if (!looksLikeToolCallStart(buffer)) continue;
        for (const tc of parseToolCallsFromText(buffer)) {
          if (tc.type === "tool_call") {
            emitToolCall(tc.callId, tc.name, tc.argumentsPart);
          }
        }
        if (emitted.length > 0) {
          this.log.info(
            `recovered ${emitted.length} tool_call(s) from the ${source} channel`,
          );
          break;
        }
      }
    }

    this.log.info(
      `chat done in ${Date.now() - startedAt}ms text=${textChars} thinking=${thinkingChars} toolCalls=${emitted.length}${
        emitted.length > 0 ? ` [${summarizeToolCalls(emitted)}]` : ""
      }${gotProviderUsage ? "" : " usage=estimated"}`,
    );
    if (textChars === 0 && thinkingChars === 0 && emitted.length === 0) {
      this.log.warn(
        `empty answer — raw text was ${rawTextAll.length} chars, thinking ${thinkingAll.length}`,
      );
      if (rawTextAll) {
        this.log.debug(`raw text head: ${rawTextAll.slice(0, 500)}`);
      }
    }

    // Fallback usage (~4 chars/token) so VS Code still shows a context gauge.
    if (!gotProviderUsage) {
      this.reportUsage(
        progress,
        Math.ceil(promptChars / 4),
        Math.ceil((textChars + thinkingChars) / 4),
      );
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
  ): Promise<number> {
    if (typeof text === "string") return estimateTokens(text);
    return (
      estimateTokens(text.content.map(partToCountableText).join("\n")) +
      PER_MESSAGE_TOKEN_OVERHEAD
    );
  }

  private reportUsage(
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    promptTokens: number,
    completionTokens: number,
  ): void {
    if (!vscode.LanguageModelDataPart) return;

    const prompt = Math.max(0, Math.floor(promptTokens));
    const completion = Math.max(0, Math.floor(completionTokens));
    progress.report(
      new vscode.LanguageModelDataPart(
        new TextEncoder().encode(
          JSON.stringify({
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
          }),
        ),
        "usage",
      ),
    );
  }

  dispose(): void {
    this._onDidChangeChatInformation.dispose();
  }
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const raw = (text ?? "").trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return undefined;
  }
}

/** read_file is the one tool models routinely call with a broken line range. */
function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "read_file") return args;

  const toNumber = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed)
      ? parsed
      : undefined;
  };

  const startLine = Math.max(1, Math.floor(toNumber(args.startLine) ?? 1));
  const rawEnd = toNumber(args.endLine);
  const endLine =
    rawEnd !== undefined && Math.floor(rawEnd) >= startLine
      ? Math.floor(rawEnd)
      : startLine + 1999;

  return { ...args, startLine, endLine };
}

/**
 * Strips raw tool protocol and echoed transcript out of a streamed text chunk.
 *
 * NOTE: horizontal whitespace is never collapsed here — this runs on every
 * partial chunk, and `/[ \t]{2,}/ → " "` ate code indentation.
 */
function sanitizeToolProtocol(text: string, enabled: boolean): string {
  if (!enabled || !text) return text;

  return (
    stripToolCallBlocks(text)
      .replace(/^\s*tool_call\s*$/gim, "\n")
      .replace(
        /^\s*(?:User:\s*)?\[(?:Tool result id=[^\]]+|toolu_[^\]]+)\][\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|\Z)/gim,
        "\n",
      )
      .replace(
        /^\s*\{\s*"status"\s*:\s*"success"[\s\S]*?"type"\s*:\s*"[^"]*_result"[\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|\Z)/gim,
        "\n",
      )
      .replace(/^\s*Tool:\s.*$/gim, "\n")
      .replace(/^\s*User:\s*Tool result:.*$/gim, "\n")
      .replace(/^\s*User:\s*\[call_[^\]]+\].*$/gim, "\n")
      .replace(/^\s*\/Users\/[^\n]*chat-session-resources[^\n]*$/gim, "\n")
      .replace(/^\s*Assistant:\s?/gim, "")
      // Only fully empty fenced blocks; real code fences stay untouched.
      .replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
  );
}
