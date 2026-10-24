import * as vscode from "vscode";
import {
  type ScopedLogger,
  createLogger,
  isDebugEnabled,
  newRequestId,
  withRequestId,
} from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import { estimateTokens } from "../providers/common/messages";
import { assembleResponse, excerpt } from "../providers/common/responseAssembler";
import type { AIMessage } from "../providers/types";
import { vsCodeMessageToAI } from "./messages";

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

/**
 * The shape of the conversation for a DEBUG line — roles, sizes, tool traffic —
 * plus the start of the last message, which is what the model answers.
 */
function describeTranscript(messages: AIMessage[]): string {
  const shown = messages.slice(-12).map((m) => {
    const extra = [
      m.toolCalls?.length && `${m.toolCalls.length} calls`,
      m.toolResults?.length && `${m.toolResults.length} results`,
    ].filter(Boolean);
    return `${m.role}(${messageChars(m)}${extra.length ? `, ${extra.join(", ")}` : ""})`;
  });
  const skipped = messages.length - shown.length;
  const last = messages[messages.length - 1];
  const lastText = last
    ? typeof last.content === "string"
      ? last.content
      : last.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ")
    : "";
  return `${skipped > 0 ? `…${skipped} earlier, ` : ""}${shown.join(" ")}${
    lastText ? ` · last: ${excerpt(lastText, 200)}` : ""
  }`;
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

  provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // Every line this request logs, down to the browser bridge, carries one id.
    return withRequestId(newRequestId(), () =>
      this.respond(model, messages, options, progress, token),
    );
  }

  private async respond(
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
    if (isDebugEnabled()) {
      this.log.debug(
        `protocol=${nativeTools ? "native" : promptToolProtocol ? "prompt" : "text"} tools: ${
          tools?.map((t) => t.name).join(", ") || "(none)"
        }`,
      );
      this.log.debug(`transcript: ${describeTranscript(aiMessages)}`);
    }

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

    const assembled = await assembleResponse(
      stream,
      {
        text: async (part) => {
          // Reasoning still sitting in its buffer must go out first. Left
          // there, it was flushed later (on the usage record, which arrives
          // mid-answer) — VS Code then saw thinking after the answer had
          // begun, folded everything before it into the collapsed steps, and
          // the visible reply started mid-word.
          await thinking.flush();
          await text.push(part);
        },
        thinking: async (part) => {
          await text.flush();
          await thinking.push(part);
        },
        toolCall: async (callId, name, input) => {
          progress.report(new vscode.LanguageModelToolCallPart(callId, name, input));
        },
        usage: async (promptTokens, completionTokens) => {
          this.reportUsage(progress, promptTokens, completionTokens);
        },
        flush: flushAll,
      },
      {
        promptToolProtocol,
        tools,
        log: this.log,
        startedAt,
        isCancelled: () => token.isCancellationRequested,
      },
    );

    // Fallback usage (~4 chars/token) so VS Code still shows a context gauge.
    if (!assembled.gotProviderUsage) {
      this.reportUsage(
        progress,
        Math.ceil(promptChars / 4),
        Math.ceil((assembled.textChars + assembled.thinkingChars) / 4),
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
