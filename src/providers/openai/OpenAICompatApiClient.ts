import { createLogger } from "../../logger";
import { throwForStatus, toProviderError } from "../common/http";
import { readText, sseEvents } from "../common/stream";
import type {
  AIMessage,
  AIRequestParams,
  AIStreamChunk,
  AIToolDefinition,
} from "../types";
import { ProviderError } from "../types";
import type { CustomProviderConfig } from "./customConfig";

/** Endpoints occasionally hold a socket open after the last token. */
const STREAM_IDLE_TIMEOUT_MS = 180000;
const MODELS_TIMEOUT_MS = 15000;
/**
 * Deadline for the response headers. Without it a busy free-tier endpoint that
 * accepts the connection and then queues the request hangs the chat forever:
 * the idle timeout only guards a stream that has already started.
 *
 * Generous on purpose — a gateway that buffers the headers until the first
 * token turns this into a deadline for the whole reasoning phase, and cutting
 * off a slow-but-working model would be worse than the hang it prevents.
 */
const RESPONSE_TIMEOUT_MS = 120000;
/** Status of the typed error raised by that timeout. */
export const RESPONSE_TIMEOUT_STATUS = 408;

const clog = createLogger("openai-compat");

export interface RequestContext {
  /** Internal provider id, used for typed errors and logs. */
  providerId: string;
  config: CustomProviderConfig;
  apiKey?: string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** `AbortSignal.any` is recent; older runtimes just get the timeout. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout])
    : signal;
}

function headers(ctx: RequestContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
    ...(ctx.config.headers ?? {}),
  };
}

/** `GET {baseUrl}/models` — the ids the endpoint is willing to serve. */
export async function listModels(
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${ctx.config.baseUrl}/models`;
  const response = await fetch(url, {
    method: "GET",
    headers: { ...headers(ctx), Accept: "application/json" },
    signal: withTimeout(signal, MODELS_TIMEOUT_MS),
  });

  if (!response.ok) {
    throwForStatus(ctx.providerId, response);
    throw toProviderError(
      ctx.providerId,
      response.status,
      await response.text().catch(() => ""),
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ id?: unknown; name?: unknown }>;
  };

  // `data[]` is the OpenAI shape; `models[]` is what a few local servers answer.
  const entries = payload.data ?? payload.models ?? [];
  const ids = entries
    .map((entry) => {
      const id = entry?.id ?? (entry as { name?: unknown })?.name;
      return typeof id === "string" ? id.trim() : "";
    })
    .filter(Boolean);

  clog.info(`${ctx.config.name}: ${ids.length} model(s) from ${url}`);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** One `/chat/completions` call, streamed. `model` is the upstream id. */
export async function* streamChatCompletion(
  params: AIRequestParams,
  ctx: RequestContext,
): AsyncIterable<AIStreamChunk> {
  const url = `${ctx.config.baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: params.model,
    messages: toOpenAIMessages(params.messages, ctx.config),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (params.toolMode !== "none" && params.tools?.length) {
    body.tools = params.tools.map(toOpenAITool);
    body.tool_choice = params.toolMode === "required" ? "required" : "auto";
  }

  let response = await post(url, body, ctx, params.abortSignal);

  // Not every server accepts the optional fields; drop them and try once more
  // rather than surfacing a 400 the user cannot act on.
  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (
      /stream_options|tool_choice|unknown|unsupported|extra field/i.test(detail)
    ) {
      clog.warn(
        `${ctx.config.name}: 400 on the optional fields, retrying without them — ${detail.slice(0, 200)}`,
      );
      delete body.stream_options;
      delete body.tool_choice;
      response = await post(url, body, ctx, params.abortSignal);
    } else {
      throw toProviderError(ctx.providerId, 400, detail);
    }
  }

  if (!response.ok) {
    throwForStatus(ctx.providerId, response);
    throw toProviderError(
      ctx.providerId,
      response.status,
      errorMessage(await response.text().catch(() => "")),
    );
  }
  if (!response.body) {
    throw new ProviderError(ctx.providerId, "empty response body");
  }

  // A server that ignores `stream: true` answers with a plain JSON completion.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    yield* wholeCompletion(await response.text(), ctx);
    return;
  }

  yield* streamEvents(response.body, ctx, params.abortSignal);
}

/**
 * POST with a deadline on the response headers only — the timer is cleared as
 * soon as they arrive, so a long generation is never cut off mid-stream. The
 * user's cancellation is forwarded for the whole life of the request.
 */
async function post(
  url: string,
  body: unknown,
  ctx: RequestContext,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort();
  else
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const timer = setTimeout(
    () =>
      controller.abort(
        new ProviderError(
          ctx.providerId,
          `${ctx.config.name} did not respond within ${Math.round(RESPONSE_TIMEOUT_MS / 1000)}s — the endpoint accepted the request and stayed silent (busy or rate-limited). Try again.`,
          RESPONSE_TIMEOUT_STATUS,
        ),
      ),
    RESPONSE_TIMEOUT_MS,
  );

  const startedAt = Date.now();
  const payload = body as {
    model?: string;
    messages?: unknown[];
    tools?: unknown[];
  };
  clog.debug(
    `${ctx.config.name}: POST model=${payload.model} messages=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers(ctx),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clog.debug(
      `${ctx.config.name}: HTTP ${response.status} in ${Date.now() - startedAt}ms`,
    );
    return response;
  } catch (err) {
    // fetch rejects with the abort reason, which is our typed error already.
    if (controller.signal.reason instanceof ProviderError) {
      clog.warn(
        `${ctx.config.name}: no response in ${Date.now() - startedAt}ms`,
      );
      throw controller.signal.reason;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function* streamEvents(
  stream: ReadableStream<Uint8Array>,
  ctx: RequestContext,
  signal?: AbortSignal,
): AsyncIterable<AIStreamChunk> {
  // Tool call fragments are keyed by `index`; id and name only come with the
  // first one, the rest carry argument pieces.
  const calls = new Map<number, { id: string; name: string }>();

  const events = sseEvents(
    readText(stream, {
      providerId: ctx.providerId,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal,
    }),
  );

  for await (const event of events) {
    const data = event.data.trim();
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") return;
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      clog.debug(
        `${ctx.config.name}: unparsable SSE data ${data.slice(0, 120)}`,
      );
      continue;
    }

    if (parsed.error) {
      throw new ProviderError(
        ctx.providerId,
        errorMessage(JSON.stringify(parsed.error)),
      );
    }

    yield* chunksFromPayload(parsed, calls);
  }

  // Reaching here means the socket closed without the sentinel; harmless, but
  // it is the signature of an upstream that dropped the answer halfway.
  clog.debug(`${ctx.config.name}: stream ended without [DONE]`);
}

/** Non-streamed answer, converted into the same chunk sequence. */
async function* wholeCompletion(
  raw: string,
  ctx: RequestContext,
): AsyncIterable<AIStreamChunk> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProviderError(
      ctx.providerId,
      `unexpected non-JSON answer: ${raw.slice(0, 200)}`,
    );
  }

  if (parsed.error) {
    throw new ProviderError(
      ctx.providerId,
      errorMessage(JSON.stringify(parsed.error)),
    );
  }

  clog.debug(`${ctx.config.name}: answered without streaming`);

  const choice = firstChoice(parsed);
  const message = (choice?.message ?? {}) as Record<string, unknown>;

  const thinking = reasoningOf(message);
  if (thinking) yield { type: "thinking", content: thinking };

  const text = textOf(message.content);
  if (text) yield { type: "text", content: text };

  for (const call of asArray(message.tool_calls)) {
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    yield {
      type: "tool_call",
      callId: typeof call.id === "string" ? call.id : `call_${name}`,
      name,
      argumentsPart: typeof fn.arguments === "string" ? fn.arguments : "{}",
    };
  }

  yield* usageChunk(parsed);
}

function* chunksFromPayload(
  parsed: Record<string, unknown>,
  calls: Map<number, { id: string; name: string }>,
): Generator<AIStreamChunk> {
  const choice = firstChoice(parsed);
  const delta = (choice?.delta ?? {}) as Record<string, unknown>;

  const thinking = reasoningOf(delta);
  if (thinking) yield { type: "thinking", content: thinking };

  const text = textOf(delta.content);
  if (text) yield { type: "text", content: text };

  for (const call of asArray(delta.tool_calls)) {
    const index = typeof call.index === "number" ? call.index : 0;
    const fn = (call.function ?? {}) as Record<string, unknown>;
    const state = calls.get(index) ?? { id: `call_${index}`, name: "" };

    if (typeof call.id === "string" && call.id) state.id = call.id;
    if (typeof fn.name === "string" && fn.name) state.name = fn.name;
    calls.set(index, state);

    // Nothing to route the arguments to yet — the name always arrives first.
    if (!state.name) continue;
    yield {
      type: "tool_call",
      callId: state.id,
      name: state.name,
      argumentsPart: typeof fn.arguments === "string" ? fn.arguments : "",
    };
  }

  yield* usageChunk(parsed);
}

function* usageChunk(
  parsed: Record<string, unknown>,
): Generator<AIStreamChunk> {
  const usage = parsed.usage as Record<string, unknown> | null | undefined;
  if (!usage) return;

  const prompt = Number(usage.prompt_tokens ?? 0);
  const completion = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return;

  yield {
    type: "usage",
    promptTokens: Number.isFinite(prompt) ? prompt : 0,
    completionTokens: Number.isFinite(completion) ? completion : 0,
  };
}

function firstChoice(
  parsed: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const choices = parsed.choices;
  return Array.isArray(choices) && choices.length > 0
    ? (choices[0] as Record<string, unknown>)
    : undefined;
}

/** `reasoning_content` (DeepSeek-style) and `reasoning` (OpenRouter) both occur. */
function reasoningOf(source: Record<string, unknown>): string {
  const value = source.reasoning_content ?? source.reasoning;
  return typeof value === "string" ? value : "";
}

/** Content is normally a string, but a few servers answer with parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

/** Pulls the human part out of an OpenAI-style error body. */
function errorMessage(raw: string): string {
  if (!raw) return "request failed";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error.message === "string") return error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON — the raw text is the best there is.
  }
  return raw;
}

function toOpenAITool(tool: AIToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters:
        Object.keys(tool.parameters ?? {}).length > 0
          ? tool.parameters
          : { type: "object", properties: {} },
    },
  };
}

/**
 * Our neutral messages in the OpenAI wire shape. Tool calls and results are
 * carried structurally (see `vsCodeMessageToAI` in native mode); a result whose
 * call was never announced is degraded to plain text, because strict servers
 * reject a `tool` message with an unknown `tool_call_id`.
 */
export function toOpenAIMessages(
  messages: AIMessage[],
  config: CustomProviderConfig,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  const announced = new Set<string>();

  for (const message of messages) {
    const orphaned: string[] = [];

    for (const toolResult of message.toolResults ?? []) {
      if (announced.has(toolResult.callId)) {
        result.push({
          role: "tool",
          tool_call_id: toolResult.callId,
          content: toolResult.content || "{}",
        });
      } else {
        orphaned.push(
          `[Tool result id=${toolResult.callId}]\n${toolResult.content}`,
        );
      }
    }

    const content = toContent(message, config);
    const toolCalls = (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments || "{}" },
    }));
    for (const call of toolCalls) announced.add(call.id);

    const extra = orphaned.join("\n\n");
    const merged = mergeContent(content, extra);

    // An assistant turn that only made tool calls has no content at all.
    if (merged === undefined && toolCalls.length === 0) continue;

    result.push({
      role: message.role,
      content: merged ?? null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  // Some servers reject an empty conversation outright.
  if (result.length === 0) {
    result.push({ role: "user", content: "" });
  }
  return result;
}

function toContent(
  message: AIMessage,
  config: CustomProviderConfig,
): string | ContentPart[] | undefined {
  if (typeof message.content === "string") {
    return message.content || undefined;
  }

  if (config.imageInput) {
    const parts: ContentPart[] = message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: part.imageUrl.url } },
    );
    return parts.length > 0 ? parts : undefined;
  }

  // Images are dropped rather than sent to an endpoint that would 400 on them.
  const text = message.content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
  return text || undefined;
}

function mergeContent(
  content: string | ContentPart[] | undefined,
  extra: string,
): string | ContentPart[] | undefined {
  if (!extra) return content;
  if (content === undefined) return extra;
  if (typeof content === "string") return `${extra}\n\n${content}`;
  return [{ type: "text", text: extra }, ...content];
}
