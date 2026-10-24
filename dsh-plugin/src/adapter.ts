import {
  type GenerateOptions,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  ReasoningEffortId,
  type StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import { createLogger } from "../../src/logger";
import type { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import { isAbortError, isNetworkFailure } from "../../src/providers/common/http";
import { assembleResponse, type ResponseSink } from "../../src/providers/common/responseAssembler";
import {
  type AIModelInfo,
  AuthExpiredError,
  ProviderError,
  RateLimitError,
  type SecretStore,
  WafChallengeError,
} from "../../src/providers/types";
import { toAIMessages } from "./messages";

const log = createLogger("dsh");

/** One harness route per web backend. */
export interface Route {
  /** Route key: `GenerateOptions.provider`. */
  id: string;
  name: string;
  provider: BaseAIProvider;
}

/** Our thinking switch, offered as the model's reasoning effort. */
const EFFORTS = [
  { id: ReasoningEffortId("auto"), name: "Auto" },
  { id: ReasoningEffortId("on"), name: "On" },
  { id: ReasoningEffortId("off"), name: "Off" },
];

export class FreeAiAdapter extends LlmAdapter {
  private readonly routes: Map<string, Route>;
  /** One sign-in at a time per route: parallel requests share its window. */
  private readonly signingIn = new Map<string, Promise<void>>();

  constructor(
    routes: readonly Route[],
    private readonly secrets: SecretStore,
    private readonly autoSignIn: boolean,
  ) {
    super();
    this.routes = new Map(routes.map((route) => [route.id, route]));
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.routes.get(provider)?.name ?? provider };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const route = this.routes.get(provider);
    if (!route) return [];
    return chatModels(route.provider).map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: ["text"],
    }));
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const route = this.routes.get(provider);
    const info = route && chatModels(route.provider).find((m) => m.id === model);
    if (!info) {
      return { provider, id: model, name: model };
    }
    return {
      provider,
      id: info.id,
      name: info.name,
      inputModalities: ["text"],
      context: { contextWindow: info.maxInputTokens },
      ...(info.capabilities.thinking
        ? { reasoning: { efforts: EFFORTS, defaultEffort: EFFORTS[0].id } }
        : {}),
    };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const route = this.routes.get(options.provider);
    if (!route) {
      throw new LlmError(`Unknown provider route: ${options.provider}`, "UNKNOWN_PROVIDER");
    }
    if (options.stop?.length) {
      throw new LlmError(`${route.name} does not support stop sequences`, "UNSUPPORTED_OPTION");
    }

    await this.ensureSignedIn(route);

    const tools = options.tools?.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const effort = String(options.reasoningEffort ?? "auto");
    const source = route.provider.sendMessageStream(
      {
        model: options.model,
        messages: toAIMessages(options.messages, options.system),
        tools: tools?.length ? tools : undefined,
        toolMode: tools?.length ? "auto" : "none",
        thinkingMode: effort === "on" || effort === "off" ? effort : "auto",
        abortSignal: options.signal,
      },
      this.secrets,
    );

    const writer = new ChunkWriter();
    const done = assembleResponse(source, writer, {
      promptToolProtocol: (tools?.length ?? 0) > 0,
      tools,
      log,
      startedAt: Date.now(),
      isCancelled: () => options.signal?.aborted === true,
    }).then(
      (assembled) => writer.finish(assembled.toolCalls.length > 0, assembled.gotProviderUsage),
      (err: unknown) => writer.fail(toLlmError(err, route.name)),
    );

    yield* writer.chunks();
    await done;
  }

  /**
   * The harness has no sign-in surface for a plugin route, so the first
   * request without a session opens the provider's sign-in window and waits.
   */
  private async ensureSignedIn(route: Route): Promise<void> {
    if (await route.provider.isAuthenticated(this.secrets)) return;
    if (!this.autoSignIn) {
      throw new LlmError(
        `${route.name}: not signed in. Enable autoSignIn or sign in once with it on.`,
        INVALID_CREDENTIAL_CODE,
      );
    }
    let pending = this.signingIn.get(route.id);
    if (!pending) {
      log.info(`${route.id}: no session, opening the sign-in window`);
      console.error(`[free-ai] ${route.name}: sign in in the browser window that just opened.`);
      pending = route.provider.login(this.secrets).finally(() => this.signingIn.delete(route.id));
      this.signingIn.set(route.id, pending);
    }
    try {
      await pending;
    } catch (err) {
      throw new LlmError(`${route.name}: sign-in failed — ${errMessage(err)}`, INVALID_CREDENTIAL_CODE, { cause: err });
    }
    if (!(await route.provider.isAuthenticated(this.secrets))) {
      throw new LlmError(`${route.name}: the sign-in was not saved. Try again.`, INVALID_CREDENTIAL_CODE);
    }
  }
}

/** Models usable for agent chat: the same filter the VS Code side applies. */
function chatModels(provider: BaseAIProvider): AIModelInfo[] {
  return provider.getModels().filter((model) => model.capabilities.chat !== false);
}

/**
 * Sink → harness chunk protocol. Text and reasoning open blocks as they come;
 * a tool call is one whole block (the assembler hands it over complete).
 */
class ChunkWriter implements ResponseSink {
  private queue: StreamChunk[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private error: unknown;
  private index = -1;
  private open: { type: "text" | "reasoning"; text: string } | undefined;
  private usageSeen: { input: number; output: number } | undefined;
  private outputChars = 0;

  async text(part: string): Promise<void> {
    this.append("text", part);
  }

  async thinking(part: string): Promise<void> {
    this.append("reasoning", part);
  }

  async toolCall(callId: string, name: string, input: Record<string, unknown>): Promise<void> {
    this.close();
    const index = ++this.index;
    const id = ToolCallId(callId);
    const args = JSON.stringify(input);
    this.push({ type: "block-start", index, blockType: "tool-call" });
    this.push({ type: "tool-call-delta", index, id, name, argumentsDelta: args });
    this.push({ type: "block-end", index, block: { type: "tool-call", id, name, arguments: args } });
  }

  async usage(promptTokens: number, completionTokens: number): Promise<void> {
    // Held back: the protocol wants usage right before finish.
    this.usageSeen = { input: promptTokens, output: completionTokens };
  }

  async flush(): Promise<void> {}

  finish(toolCalls: boolean, providerUsage: boolean): void {
    this.close();
    const usage = providerUsage && this.usageSeen
      ? this.usageSeen
      : // ~4 chars/token, as the VS Code side estimates when the backend is silent.
        { input: 0, output: Math.ceil(this.outputChars / 4) };
    this.push({ type: "usage", usage: { inputTokens: usage.input, outputTokens: usage.output } });
    this.push({ type: "finish", reason: { kind: toolCalls ? "tool-calls" : "stop" } });
    this.end();
  }

  fail(error: unknown): void {
    this.error = error;
    this.end();
  }

  async *chunks(): AsyncIterable<StreamChunk> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift() as StreamChunk;
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private append(type: "text" | "reasoning", part: string): void {
    if (!part) return;
    if (this.open?.type !== type) {
      this.close();
      this.open = { type, text: "" };
      this.push({ type: "block-start", index: ++this.index, blockType: type });
    }
    this.open.text += part;
    this.outputChars += part.length;
    this.push(
      type === "text"
        ? { type: "text-delta", index: this.index, text: part }
        : { type: "reasoning-delta", index: this.index, text: part },
    );
  }

  private close(): void {
    if (!this.open) return;
    const { type, text } = this.open;
    this.open = undefined;
    this.push({ type: "block-end", index: this.index, block: { type, text } });
  }

  private push(chunk: StreamChunk): void {
    this.queue.push(chunk);
    this.wake?.();
    this.wake = undefined;
  }

  private end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }
}

/** Our provider errors → harness codes, so its retry policy can tell them apart. */
export function toLlmError(err: unknown, routeName: string): unknown {
  if (err instanceof LlmError) return err;
  if (isAbortError(err)) return err;
  const message = `${routeName}: ${errMessage(err)}`;
  if (err instanceof AuthExpiredError) {
    return new LlmError(
      `${routeName}: the session expired or was refused. The next request opens the sign-in window.`,
      INVALID_CREDENTIAL_CODE,
      { status: err.status ?? 401, cause: err },
    );
  }
  if (err instanceof RateLimitError) {
    return new LlmError(message, "RATE_LIMITED", {
      status: 429,
      ...(err.retryAfterMs ? { providerRetryAfterMs: err.retryAfterMs } : {}),
      cause: err,
    });
  }
  if (err instanceof WafChallengeError) return new LlmError(message, "ANTI_BOT", { cause: err });
  if (isNetworkFailure(err)) return new LlmError(message, "NETWORK", { cause: err });
  if (err instanceof ProviderError) {
    const status = err.statusCode && err.statusCode >= 100 && err.statusCode <= 599 ? err.statusCode : undefined;
    return new LlmError(message, "PROVIDER_ERROR", { ...(status ? { status } : {}), cause: err });
  }
  return new LlmError(message, "PROVIDER_ERROR", { cause: err });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
