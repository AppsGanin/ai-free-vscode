import { errToString, log } from "../../logger";
import { isAbortError, isNetworkFailure, throwForStatus } from "../common/http";
import {
  LANGUAGE_GUARD,
  buildRolePrompt,
  contentToString,
} from "../common/messages";
import { thinkingEnabled } from "../common/models";
import { readText } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import {
  buildToolsSystemPrompt,
  createToolCallChunk,
  summarizeToolCalls,
} from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { ProviderError, WafChallengeError } from "../types";
import type { QwenBrowserBridge } from "./QwenBrowserBridge";
import { QWEN_MODELS, resolveModelId } from "./QwenModels";

const ORIGIN = "https://chat.qwen.ai";
const CHAT_API_URL = `${ORIGIN}/api/v2/chat/completions`;
const CREATE_CHAT_URL = `${ORIGIN}/api/v2/chats/new`;
const STOP_CHAT_URL = `${ORIGIN}/api/v2/chat/completions/stop`;
const PROVIDER_ID = "ai-free-vscode-qwen";

// App headers sent by chat.qwen.ai. Judging by the traffic these (source /
// version / x-request-id), not the heavy bx-* signature, are the WAF gate.
// The versions drift over time.
const WEB_VERSION = "0.2.68";
const BX_V = "2.5.36";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Well inside the model's declared 1M window. Counted in tokens, not
// characters: the same character count costs about twice the tokens in
// Cyrillic/CJK, so a flat character cap overruns the window on those chats.
const MAX_PROMPT_TOKENS = 125000;
const MAX_SYSTEM_MESSAGE_CHARS = 100000;
const THINKING_BUDGET_TOKENS = 4096;
const STREAM_TIMEOUT_MS = 120000;

// Guards against a tool-mode answer that never produces a call: the model would
// otherwise keep talking around the tools it was told to use.
const MAX_TOOLMODE_NO_TOOLCALL_MS = 20000;
const MAX_TOOLMODE_NO_TOOLCALL_CHARS = 12000;
const MIN_TOOLMODE_GUARD_TEXT_CHARS = 64;

// A busy chat is rarely freed by stop_stream: two quick retries cover a race,
// after that a brand new chat_id is cheaper.
const CHAT_IN_PROGRESS_RETRY_DELAYS_MS = [500, 1000];

interface QwenRequestBody {
  stream: boolean;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: "normal";
  messages: Array<Record<string, unknown>>;
  model: string;
  parent_id?: string;
  system_message?: string;
  timestamp?: number;
}

type QwenContentPart =
  { type: "text"; text: string } | { type: "image"; image: string };

interface QwenStreamDelta {
  role?: string;
  /** Tool name in the service `role=function` deltas. */
  name?: string;
  phase?: "think" | "answer" | string;
  content?: string;
  reasoning_content?: string;
  /**
   * Qwen emits calls in the legacy OpenAI `function_call` shape, not in
   * `tool_calls`. Arguments arrive as growing snapshots: "" → "{\"path\": " → …
   */
  function_call?: { name?: string; arguments?: string };
  tool_calls?: Array<{
    index: number;
    id: string;
    function: { name: string; arguments: string };
  }>;
}

interface QwenStreamChunk {
  choices?: Array<{ delta: QwenStreamDelta; finish_reason: string | null }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: unknown;
  details?: unknown;
}

function appHeaders(token: string, referer: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    source: "web",
    version: WEB_VERSION,
    "bx-v": BX_V,
    "x-request-id": crypto.randomUUID(),
    // As in the app: Date().toString() without the parenthesised zone name,
    // which may contain non-latin1 characters and break the header.
    timezone: new Date().toString().replace(/\s*\(.*\)\s*$/, ""),
    Origin: ORIGIN,
    Referer: referer,
    "User-Agent": USER_AGENT,
  };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class QwenApiClient {
  constructor(private readonly browser?: QwenBrowserBridge) {}

  /**
   * @param onChatIdChanged Fired when the client moved to a new chat_id (busy
   * chat, dropped connection, internal error). The provider caches chat_id per
   * conversation and would keep posting into a dead chat without this.
   */
  async *sendMessageStream(
    params: AIRequestParams,
    token: string,
    onChatIdChanged?: (chatId: string) => void,
  ): AsyncIterable<AIStreamChunk> {
    const bearer = normalizeToken(token);
    const model = resolveModelId(params.model);
    let chatId = params.chatId;

    if (!chatId) {
      chatId = await this.createChat(bearer, model);
      if (!chatId) {
        throw new ProviderError(
          PROVIDER_ID,
          "Failed to create chat_id in Qwen API",
        );
      }
      log(`[qwen-api] created chat_id=${chatId}`);
    }

    const allowToolCalls = params.toolMode !== "none";
    const hasTools = allowToolCalls && (params.tools?.length ?? 0) > 0;
    const body = this.buildPayload(params, model, chatId, hasTools);

    log(
      `[qwen-api] POST model=${model} messages=${params.messages.length} chat_id=${chatId}`,
    );

    // Anything already shown to the user makes a retry unsafe: the answer would
    // be streamed twice.
    let streamedToUser = false;

    const send = async function* (
      this: QwenApiClient,
      currentBody: QwenRequestBody,
      currentChatId: string,
    ): AsyncIterable<AIStreamChunk> {
      for await (const chunk of this.streamOnce(
        currentBody,
        currentChatId,
        bearer,
        allowToolCalls,
        params.abortSignal,
      )) {
        if (chunk.type === "text" || chunk.type === "tool_call") {
          streamedToUser = true;
        }
        yield chunk;
      }
    }.bind(this);

    const inFreshChat = async (
      reason: string,
      resetParent: boolean,
    ): Promise<{ body: QwenRequestBody; chatId: string } | undefined> => {
      log(`[qwen-api] ${reason} — retrying in a NEW chat_id`);
      const freshChatId = await this.createChat(bearer, model);
      if (!freshChatId) return undefined;
      onChatIdChanged?.(freshChatId);
      return {
        chatId: freshChatId,
        body: resetParent
          ? withoutParent(body, freshChatId)
          : { ...body, chat_id: freshChatId },
      };
    };

    try {
      yield* send(body, chatId);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      if (isAbortError(error, params.abortSignal)) {
        // Leaving the upstream running makes the next request in this chat fail
        // with "The chat is in progress!".
        await this.stopStream(bearer, chatId).catch(() => undefined);
        throw error;
      }

      if (streamedToUser) {
        log("[qwen-api] failed mid-answer — not retrying, it would duplicate");
        throw error;
      }

      // Aliyun WAF blocked the direct stream — repeat it inside a real browser
      // session (cookies + browser fingerprint).
      if (error instanceof WafChallengeError && this.browser) {
        log(
          "[qwen-api] WAF blocked node-streaming, retrying via browser session",
        );
        yield* this.parseSSE(
          this.browser.streamChat({
            url: requestUrl(chatId),
            token: bearer,
            body,
            chatId,
            abortSignal: params.abortSignal,
          }),
          allowToolCalls,
        );
        return;
      }

      if (/chat is in progress/i.test(msg)) {
        for (const delayMs of CHAT_IN_PROGRESS_RETRY_DELAYS_MS) {
          await this.stopStream(bearer, chatId).catch(() => undefined);
          await sleep(delayMs);
          try {
            yield* send(body, chatId);
            return;
          } catch (retryError) {
            const retryMsg =
              retryError instanceof Error
                ? retryError.message
                : String(retryError);
            if (!/chat is in progress/i.test(retryMsg)) throw retryError;
          }
        }

        // History is resent in the prompt, so nothing is lost by moving on.
        const fresh = await inFreshChat("chat still in progress", false);
        if (!fresh) throw error;
        yield* send(fresh.body, fresh.chatId);
        return;
      }

      // A dropped connection (TLS reset before or during the stream) or an
      // upstream hiccup: both need a clean chat. The parent message belongs to
      // the abandoned one, so it is dropped either way.
      const dropped = isNetworkFailure(error);
      const internal = /internal error/i.test(msg);
      if (dropped || internal) {
        const fresh = await inFreshChat(
          dropped
            ? `connection failed (${errToString(error)})`
            : "upstream internal error",
          true,
        );
        if (!fresh) {
          throw new ProviderError(
            PROVIDER_ID,
            "Failed to create a new chat for retry",
          );
        }
        yield* send(fresh.body, fresh.chatId);
        return;
      }

      throw error;
    }
  }

  async createChat(token: string, model: string): Promise<string | undefined> {
    // Fields and order as in the web app's POST /api/v2/chats/new.
    const payload = {
      chatId: "",
      models: [model],
      project_id: "",
      timestamp: Date.now(),
      chat_type: "t2t",
      chat_mode: "normal",
    };

    const result = await this.postCreateChat(token, payload);
    if (!result?.ok) {
      log(
        `[qwen-api] createChat failed status=${result?.status ?? "n/a"} body=${(
          result?.text ?? ""
        ).slice(0, 300)}`,
      );
      return undefined;
    }

    try {
      const data = JSON.parse(result.text) as {
        data?: { id?: string; chat_id?: string };
        id?: string;
      };
      const chatId = data?.data?.id ?? data?.data?.chat_id ?? data?.id;
      if (!chatId) {
        log(`[qwen-api] createChat ok but no id: ${result.text.slice(0, 300)}`);
      }
      return chatId;
    } catch {
      log(
        `[qwen-api] createChat ok but not JSON: ${result.text.slice(0, 200)}`,
      );
      return undefined;
    }
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  private async *streamOnce(
    body: QwenRequestBody,
    chatId: string,
    token: string,
    allowToolCalls: boolean,
    abortSignal?: AbortSignal,
  ): AsyncIterable<AIStreamChunk> {
    const response = await fetch(requestUrl(chatId), {
      method: "POST",
      headers: appHeaders(token, `${ORIGIN}/c/${chatId}`),
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    const contentType = (
      response.headers.get("content-type") ?? ""
    ).toLowerCase();
    log(
      `[qwen-api] response status=${response.status} contentType=${contentType || "n/a"}`,
    );

    throwForStatus(PROVIDER_ID, response, [401]);
    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      throw new ProviderError(
        PROVIDER_ID,
        `HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        response.status,
      );
    }

    // completions must return SSE. Anything else is an error or an anti-bot:
    // Aliyun WAF (text/html) or Alibaba x5sec/RGV587 (JSON with a /punish link).
    if (!contentType.includes("text/event-stream")) {
      const text = (await response.text().catch(() => "")).slice(0, 400);
      if (
        contentType.includes("text/html") ||
        /FAIL_SYS_USER_VALIDATE|RGV587|x5sec|_____tmd_____|\/punish/i.test(text)
      ) {
        throw new WafChallengeError(
          PROVIDER_ID,
          `anti-bot challenge (content-type=${contentType || "n/a"}): ${text}`,
        );
      }
      throw new ProviderError(
        PROVIDER_ID,
        `Unexpected non-SSE response (content-type=${contentType || "n/a"}): ${text}`,
      );
    }
    if (!response.body) {
      throw new ProviderError(PROVIDER_ID, "Response body is empty");
    }

    yield* this.parseSSE(
      readText(response.body, {
        providerId: PROVIDER_ID,
        idleTimeoutMs: STREAM_TIMEOUT_MS,
        signal: abortSignal,
      }),
      allowToolCalls,
    );
  }

  /** POST /chats/new directly; on an HTTP/WAF/network failure via the browser. */
  private async postCreateChat(
    token: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status: number; text: string } | undefined> {
    let direct: { ok: boolean; status: number; text: string } | undefined;

    try {
      const response = await fetch(CREATE_CHAT_URL, {
        method: "POST",
        headers: appHeaders(token, `${ORIGIN}/`),
        body: JSON.stringify(payload),
      });
      const text = await response.text().catch(() => "");
      const wafBlocked = (response.headers.get("content-type") ?? "")
        .toLowerCase()
        .includes("text/html");

      if (response.ok && !wafBlocked) {
        return { ok: true, status: response.status, text };
      }
      direct = { ok: response.ok, status: response.status, text };
      log(
        `[qwen-api] createChat via node blocked (status=${response.status} waf=${wafBlocked})`,
      );
    } catch (err) {
      log(`[qwen-api] createChat node error (${String(err)})`);
    }

    if (!this.browser) return direct;

    log("[qwen-api] createChat retrying via browser session");
    return this.browser
      .postJson(CREATE_CHAT_URL, token, payload)
      .catch((err) => {
        log(`[qwen-api] createChat via browser failed: ${String(err)}`);
        return undefined;
      });
  }

  private async stopStream(token: string, chatId: string): Promise<void> {
    const response = await fetch(
      `${STOP_CHAT_URL}?chat_id=${encodeURIComponent(chatId)}`,
      {
        method: "POST",
        headers: {
          ...appHeaders(token, `${ORIGIN}/c/${chatId}`),
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({ chat_id: chatId }),
      },
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new ProviderError(
        PROVIDER_ID,
        `stop_stream failed HTTP ${response.status}: ${errText.slice(0, 200)}`,
        response.status,
      );
    }
    log(`[qwen-api] stop_stream ok chat_id=${chatId}`);
  }

  // ─── Request payload ──────────────────────────────────────────────────────

  private buildPayload(
    params: AIRequestParams,
    model: string,
    chatId: string,
    hasTools: boolean,
  ): QwenRequestBody {
    const prompt = buildRolePrompt(params.messages, {
      maxTokens: MAX_PROMPT_TOKENS,
    });
    const content = attachImages(params.messages, prompt);

    // The tools protocol is appended after the cap: it must never be truncated.
    const systemMessage = [
      [
        LANGUAGE_GUARD,
        ...params.messages
          .filter((m) => m.role === "system")
          .map((m) => contentToString(m.content)),
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, MAX_SYSTEM_MESSAGE_CHARS),
      hasTools ? buildToolsSystemPrompt(params.tools ?? []) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const thinking = thinkingEnabled(
      QWEN_MODELS,
      model,
      hasTools,
      params.thinkingMode,
    );
    log(
      `[qwen-api] promptChars=${prompt.length} systemChars=${systemMessage.length} thinking=${thinking}`,
    );

    return {
      stream: true,
      incremental_output: true,
      chat_id: chatId,
      chat_mode: "normal",
      model,
      parent_id: params.parentId,
      timestamp: Date.now(),
      system_message: systemMessage,
      messages: [
        {
          fid: crypto.randomUUID(),
          parentId: params.parentId,
          parent_id: params.parentId,
          role: "user",
          content,
          chat_type: "t2t",
          sub_chat_type: "t2t",
          timestamp: Math.floor(Date.now() / 1000),
          user_action: "chat",
          models: [model],
          files: [],
          childrenIds: [crypto.randomUUID()],
          extra: { meta: { subChatType: "t2t" } },
          feature_config: {
            thinking_enabled: thinking,
            ...(thinking
              ? { thinking_budget_tokens: THINKING_BUDGET_TOKENS }
              : {}),
            output_schema: "phase",
          },
        },
      ],
    };
  }

  // ─── SSE ──────────────────────────────────────────────────────────────────

  private async *parseSSE(
    chunkSource: AsyncIterable<string>,
    allowToolCalls: boolean,
  ): AsyncIterable<AIStreamChunk> {
    // The router catches ```tool_call``` markers with a sliding window and holds
    // a potential call back until the end of the stream.
    const router = new StreamingToolCallRouter(
      allowToolCalls,
      log,
      "[qwen-api] ",
    );
    const nativeToolCalls: AIStreamChunk[] = [];
    /** Growing snapshot of the current function_call (see QwenStreamDelta). */
    let pendingFn: { name: string; args: string } | undefined;

    const startedAt = Date.now();
    let fullText = "";
    let streamedTextChars = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let firstAnswerAt: number | undefined;
    let buffer = "";

    const processChunk = function* (
      parsed: QwenStreamChunk,
    ): Iterable<AIStreamChunk> {
      if (parsed.error) {
        const combined = [
          stringifyUnknown(parsed.error) || "Qwen API error",
          stringifyUnknown(parsed.details),
        ]
          .filter(Boolean)
          .join(": ");
        // Content already started: this is Qwen dropping the stream at the end,
        // not a real failure. Finish gracefully.
        if (fullText.length > 0 || streamedTextChars > 0) {
          log(
            `[qwen-api] internal_error mid-stream — treating as stream end: ${combined}`,
          );
          return;
        }
        throw new ProviderError(PROVIDER_ID, combined);
      }

      if (parsed.usage) {
        promptTokens =
          parsed.usage.prompt_tokens ??
          parsed.usage.input_tokens ??
          promptTokens;
        completionTokens =
          parsed.usage.completion_tokens ??
          parsed.usage.output_tokens ??
          completionTokens;
      }

      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta;
        if (!delta) continue;

        // Qwen tries our call against its own server-side registry (image-gen,
        // code-interpreter, amap…), where our names do not exist, and reports
        // the rejection as a `role=function` delta. That is their internal
        // channel, not model output — it must not reach the answer.
        if (delta.role === "function") {
          log(
            `[qwen-api] server-side tool rejection name=${delta.name ?? "?"} content=${(delta.content ?? "").slice(0, 120)}`,
          );
          continue;
        }

        const phase = String(delta.phase ?? "answer").toLowerCase();
        const raw = delta.content ?? "";
        // Thinking arrives either in reasoning_content or as content+phase=think.
        const thinking =
          (delta.reasoning_content ?? "") + (phase === "think" ? raw : "");
        if (thinking) {
          yield { type: "thinking", content: thinking };
        }

        const content = phase === "think" ? "" : raw;
        if (content) {
          firstAnswerAt ??= Date.now();
          fullText += content;
          for (const chunk of router.route(content)) {
            if (chunk.type === "text")
              streamedTextChars += chunk.content.length;
            yield chunk;
          }
        }

        for (const toolCall of delta.tool_calls ?? []) {
          nativeToolCalls.push(
            createToolCallChunk({
              callId: toolCall.id || `call_${toolCall.index}`,
              name: toolCall.function?.name ?? "",
              argumentsPart: toolCall.function?.arguments ?? "",
            }),
          );
        }

        // The call itself lands in function_call. Qwen then fails it in its own
        // registry, but the call arrived complete — enough for VS Code.
        const fnCall = delta.function_call;
        if (fnCall && nativeToolCalls.length === 0) {
          const name = fnCall.name || pendingFn?.name || "";
          const args = fnCall.arguments ?? "";
          // Snapshots only grow: a shorter payload or a new name starts a call.
          if (
            pendingFn &&
            (pendingFn.name !== name || args.length < pendingFn.args.length)
          ) {
            pendingFn = undefined;
          }
          pendingFn = { name, args };

          const parsedArgs = parseCompleteJsonArgs(args);
          if (parsedArgs && name) {
            nativeToolCalls.push(
              createToolCallChunk({ name, argumentsValue: parsedArgs }),
            );
            log(`[qwen-api] recovered function_call name=${name}`);
          }
        }
      }
    };

    const processLine = function* (line: string): Iterable<AIStreamChunk> {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") return;

      if (!trimmed.startsWith("data: ")) {
        // Sometimes the upstream answers with a bare JSON object instead of SSE
        // (including success:false at status 200). Never swallow that.
        if (trimmed.startsWith("{")) {
          const json = tryParse<{
            success?: boolean;
            data?: { code?: string; details?: unknown };
          }>(trimmed);
          if (json?.success === false) {
            const details =
              typeof json.data?.details === "string"
                ? json.data.details
                : JSON.stringify(json.data?.details ?? "");
            throw new ProviderError(
              PROVIDER_ID,
              `${json.data?.code ?? "Bad_Request"}: ${details}`,
            );
          }
        }
        return;
      }

      const parsed = tryParse<QwenStreamChunk>(trimmed.slice("data: ".length));
      if (parsed) yield* processChunk(parsed);
    };

    // Breaking out closes chunkSource: it cancels the reader for a direct
    // response and stops the in-page fetch for the browser path.
    for await (const piece of chunkSource) {
      buffer += piece;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield* processLine(line);
      }

      if (router.cut) {
        log("[qwen-api] transcript boundary detected — stopping stream");
        break;
      }

      // Call collected — Qwen will now reject it in its registry and the model
      // will ramble about a non-existent error. We do not need that tail.
      if (allowToolCalls && nativeToolCalls.length > 0) {
        log("[qwen-api] function_call recovered — stopping stream");
        break;
      }

      if (
        allowToolCalls &&
        nativeToolCalls.length === 0 &&
        fullText.length >= MIN_TOOLMODE_GUARD_TEXT_CHARS &&
        !router.holding &&
        (fullText.length >= MAX_TOOLMODE_NO_TOOLCALL_CHARS ||
          (firstAnswerAt !== undefined &&
            Date.now() - firstAnswerAt >= MAX_TOOLMODE_NO_TOOLCALL_MS))
      ) {
        log(
          `[qwen-api] stream guard stop: no tool_call after ${fullText.length} chars`,
        );
        break;
      }
    }

    if (buffer.trim()) {
      yield* processLine(buffer);
    }

    let emittedAnything = streamedTextChars > 0;
    let toolCalls = 0;

    if (allowToolCalls && nativeToolCalls.length > 0) {
      // Native calls win; held text is flushed as text so it cannot become a
      // duplicate call.
      log(
        `[qwen-api] native tool calls: ${summarizeToolCalls(nativeToolCalls)}`,
      );
      yield* router.finishAsText();
      yield* nativeToolCalls;
      toolCalls = nativeToolCalls.length;
      emittedAnything = true;
    } else {
      for (const chunk of router.finish()) {
        if (chunk.type === "tool_call") toolCalls++;
        yield chunk;
        emittedAnything = true;
      }
    }

    // Last resort: the model generated something but nothing reached the user.
    // Not after a transcript cut though — fullText holds the hallucinated turn
    // we just trimmed away.
    if (!emittedAnything && !router.cut && fullText.trim()) {
      yield { type: "text", content: fullText };
    }

    if (promptTokens > 0 || completionTokens > 0) {
      yield { type: "usage", promptTokens, completionTokens };
    }

    log(
      `[qwen-api] stream done in ${Date.now() - startedAt}ms chars=${fullText.length} emitted=${streamedTextChars} toolCalls=${toolCalls} usage=${promptTokens}/${completionTokens}${router.cut ? " (cut at transcript boundary)" : ""}`,
    );
  }
}

const requestUrl = (chatId: string) =>
  `${CHAT_API_URL}?chat_id=${encodeURIComponent(chatId)}`;

/** Drops the parent link so a resend starts a fresh thread in a new chat. */
function withoutParent(body: QwenRequestBody, chatId: string): QwenRequestBody {
  const [first, ...rest] = body.messages;
  const head = { ...first };
  delete head.parentId;
  delete head.parent_id;

  return {
    ...body,
    chat_id: chatId,
    parent_id: undefined,
    messages: [head, ...rest.map((m) => ({ ...m }))],
    timestamp: Date.now(),
  };
}

/** Sends the prompt plus any images of the latest user message. */
function attachImages(
  messages: AIMessage[],
  prompt: string,
): string | QwenContentPart[] {
  const latest = [...messages].reverse().find((m) => m.role === "user");
  if (!latest || typeof latest.content === "string") return prompt;

  const images = latest.content
    .filter((part) => part.type === "image_url" && !!part.imageUrl?.url)
    .map((part) => ({
      type: "image" as const,
      image: (part as { imageUrl: { url: string } }).imageUrl.url,
    }));
  if (images.length === 0) return prompt;

  log(`[qwen-api] attaching ${images.length} image(s) from the latest message`);
  return [{ type: "text", text: prompt }, ...images];
}

/**
 * Parses a growing function_call arguments snapshot. Returns a value only once
 * the JSON is syntactically complete — an unclosed brace means it is still
 * streaming.
 */
function parseCompleteJsonArgs(
  raw: string,
): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  const parsed = tryParse<Record<string, unknown>>(trimmed);
  return parsed && !Array.isArray(parsed) ? parsed : undefined;
}

function tryParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function stringifyUnknown(value: unknown, maxLen = 600): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name;
  if (typeof value !== "object") return String(value);

  const nested = (value as { message?: unknown }).message;
  if (typeof nested === "string" && nested.trim()) return nested;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > maxLen
      ? `${serialized.slice(0, maxLen)}…`
      : serialized;
  } catch {
    return String(value);
  }
}

/** Strips Bearer prefixes and stray quotes from a stored token. */
function normalizeToken(token: string): string {
  let t = token
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}
