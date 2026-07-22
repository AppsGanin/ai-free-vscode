import { log } from "../../logger";
import { throwForStatus } from "../common/http";
import { LANGUAGE_GUARD, buildRolePrompt } from "../common/messages";
import { thinkingEnabled } from "../common/models";
import { readText, sseEvents } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import { buildToolsSystemPrompt } from "../common/ToolCalling";
import type { AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError } from "../types";
import {
  DEEPSEEK_MODELS,
  resolveDeepSeekModelId,
  toDeepSeekApiModelType,
} from "./DeepSeekModels";

const PROVIDER_ID = "ai-free-vscode-deepseek";
const BASE_URL = "https://chat.deepseek.com";
const CREATE_SESSION_PATH = "/api/v0/chat_session/create";
const CREATE_POW_CHALLENGE_PATH = "/api/v0/chat/create_pow_challenge";
const COMPLETION_PATH = "/api/v0/chat/completion";
const STOP_STREAM_PATH = "/api/v0/chat/stop_stream";
const APP_VERSION = "2.2.0";
const DEEPSEEK_SHA3_WASM =
  "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

const STREAM_TIMEOUT_MS = 30000;
/**
 * Roughly the model's 128k input window at ~3 chars per token. Agent turns
 * carry whole files in their tool results and blow past it easily; the oldest
 * turns are dropped rather than letting the upstream answer with nothing.
 */
const MAX_PROMPT_CHARS = 300000;

export interface DeepSeekAuthState {
  token?: string;
  cookieHeader: string;
}

interface PowChallenge {
  algorithm: string;
  challenge: string;
  salt: string;
  difficulty: number;
  expire_at?: number;
  expireAt?: number;
  signature: string;
}

interface DeepSeekResponseJson {
  code?: number;
  msg?: string;
  data?: {
    code?: number;
    biz_code?: number;
    biz_msg?: string;
    biz_data?: {
      id?: string;
      chat_session?: { id?: string };
      challenge?: PowChallenge;
    };
  };
}

/** Target of a content patch: the answer channel or the reasoning channel. */
type PatchTarget = "text" | "thinking";

/**
 * Patches for the same path arrive abbreviated: first
 * `{"p":"response/content","o":"APPEND","v":"H"}`, then just `{"v":"e"}`.
 * `lastTarget` keeps such tails routed to the right channel, and
 * `fragmentTargets` records the type of each fragment by creation order —
 * `response/fragments/<N>/content` carries no THINK/RESPONSE marker itself.
 */
interface PatchState {
  lastTarget: PatchTarget;
  fragmentTargets: PatchTarget[];
}

export class DeepSeekApiClient {
  async createSession(
    auth: DeepSeekAuthState,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const json = await this.requestJson(
      CREATE_SESSION_PATH,
      auth,
      {},
      abortSignal,
    );
    const biz = json?.data?.biz_data;
    const sessionId = biz?.id ?? biz?.chat_session?.id;
    if (!sessionId) {
      throw new ProviderError(
        PROVIDER_ID,
        `Failed to get DeepSeek session id: ${JSON.stringify(json).slice(0, 250)}`,
      );
    }
    return sessionId;
  }

  async *sendMessageStream(
    params: AIRequestParams,
    auth: DeepSeekAuthState,
    options?: { onMessageId?: (messageId: number) => void },
  ): AsyncIterable<AIStreamChunk> {
    const sessionId = params.chatId;
    if (!sessionId) {
      throw new ProviderError(
        PROVIDER_ID,
        "Missing session_id for the request",
      );
    }

    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;
    const modelType = toDeepSeekApiModelType(params.model);
    const thinking = thinkingEnabled(
      DEEPSEEK_MODELS,
      resolveDeepSeekModelId(params.model),
      hasTools,
      params.thinkingMode,
    );

    // The tools prompt already carries the language instruction, and is added
    // after the cap so the protocol itself is never trimmed away.
    const prompt = buildRolePrompt(params.messages, {
      system: hasTools
        ? buildToolsSystemPrompt(params.tools ?? [])
        : LANGUAGE_GUARD,
      maxChars: MAX_PROMPT_CHARS,
    });
    const parentMessageId = Number(params.parentId);

    log(
      `[deepseek-api] request model=${modelType} thinking=${thinking} hasTools=${hasTools}`,
    );

    const response = await fetch(`${BASE_URL}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(auth),
        "X-DS-PoW-Response": await this.createPowHeader(
          auth,
          COMPLETION_PATH,
          params.abortSignal,
        ),
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: Number.isFinite(parentMessageId)
          ? Math.floor(parentMessageId)
          : null,
        model_type: modelType,
        preempt: false,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinking,
        search_enabled: false,
      }),
      signal: params.abortSignal,
    });

    throwForStatus(PROVIDER_ID, response);

    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok || !contentType.includes("text/event-stream")) {
      this.throwCompletionHttpError(
        response.status,
        await response.text().catch(() => ""),
      );
    }
    if (!response.body) {
      throw new ProviderError(PROVIDER_ID, "Response body is empty");
    }

    const router = new StreamingToolCallRouter(
      allowToolCalls,
      log,
      "[deepseek-api] ",
    );
    const cache = new Map<string, string>();
    const state: PatchState = { lastTarget: "text", fragmentTargets: [] };
    // Needed to stop generation server-side on an early break: a plain cancel
    // leaves the message "wip" and the next request in this session fails.
    let currentMessageId: number | undefined;
    let textChunks = 0;
    let thinkingChunks = 0;
    // Diagnostics for the "finished but said nothing" case: they separate an
    // empty upstream from content we failed to extract or held back. Most
    // unrecognised events are harmless metadata (status, token counts), so the
    // samples are only reported if the answer really did come out empty.
    let events = 0;
    let extractedChars = 0;
    const unrecognised: string[] = [];
    const startedAt = Date.now();
    let cutShort = false;

    for await (const event of sseEvents(
      readText(response.body, {
        providerId: PROVIDER_ID,
        idleTimeoutMs: STREAM_TIMEOUT_MS,
      }),
    )) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }
      events++;

      this.throwIfSseBizError(parsed);
      const { text, thinking, messageId } = extractDelta(parsed, cache, state);
      extractedChars += text.length + thinking.length;

      if (!text && !thinking && messageId === null && unrecognised.length < 5) {
        unrecognised.push(event.data.slice(0, 300));
      }

      if (typeof messageId === "number") {
        currentMessageId = messageId;
        options?.onMessageId?.(messageId);
      }
      if (thinking) {
        thinkingChunks++;
        yield { type: "thinking", content: thinking };
      }
      for (const chunk of router.route(text)) {
        if (chunk.type === "text") textChunks++;
        yield chunk;
      }

      // The transcript guard fired: the upstream is only play-acting the rest of
      // the dialog now. Stop it properly, then drop the read.
      if (router.cut) {
        cutShort = true;
        log("[deepseek-api] transcript boundary detected — stopping stream");
        await this.stopStream(auth, sessionId, currentMessageId).catch((err) =>
          log(`[deepseek-api] stop_stream failed: ${String(err)}`),
        );
        break;
      }
    }

    let toolCalls = 0;
    for (const chunk of router.finish()) {
      if (chunk.type === "text") textChunks++;
      if (chunk.type === "tool_call") toolCalls++;
      yield chunk;
    }

    log(
      `[deepseek-api] stream done in ${Date.now() - startedAt}ms model=${modelType} events=${events} chars=${extractedChars} textChunks=${textChunks} thinkingChunks=${thinkingChunks} toolCalls=${toolCalls} promptChars=${prompt.length}${cutShort ? " (cut at transcript boundary)" : ""}`,
    );

    if (textChunks === 0 && thinkingChunks === 0 && toolCalls === 0) {
      log(
        `[deepseek-api] stream produced nothing — allowToolCalls=${allowToolCalls}`,
      );
      for (const sample of unrecognised) {
        log(`[deepseek-api]   unrecognised event: ${sample}`);
      }
    }
  }

  async stopStream(
    auth: DeepSeekAuthState,
    sessionId: string,
    messageId?: number,
  ): Promise<void> {
    await this.requestJson(STOP_STREAM_PATH, auth, {
      chat_session_id: sessionId,
      ...(Number.isFinite(messageId) ? { message_id: messageId } : {}),
    });
  }

  private throwIfSseBizError(parsed: unknown): void {
    const data = parsed as {
      type?: unknown;
      content?: unknown;
      finish_reason?: unknown;
      biz_code?: unknown;
      biz_msg?: unknown;
      data?: { biz_code?: unknown; biz_msg?: unknown };
    } | null;
    if (!data || typeof data !== "object") return;

    // In-stream failure frame, e.g. the one-generation-per-account limit:
    // {"type":"error","content":"…","finish_reason":"parallel_chat_limit"}
    if (data.type === "error" && typeof data.content === "string") {
      const reason = data.finish_reason
        ? ` (${String(data.finish_reason)})`
        : "";
      throw new ProviderError(PROVIDER_ID, `${data.content}${reason}`);
    }

    const code = data.data?.biz_code ?? data.biz_code;
    if (typeof code === "number" && code !== 0) {
      const msg = data.data?.biz_msg ?? data.biz_msg;
      throw new ProviderError(
        PROVIDER_ID,
        `DeepSeek biz error ${code}: ${typeof msg === "string" ? msg : "Unknown error"}`,
      );
    }
  }

  private throwCompletionHttpError(status: number, text: string): never {
    let message = `HTTP ${status}: ${text.slice(0, 220)}`;
    try {
      const parsed = JSON.parse(text) as {
        code?: number;
        msg?: string;
        data?: { biz_code?: number; biz_msg?: string };
      };
      if (parsed.code === 40002 || parsed.code === 40003) {
        throw new AuthExpiredError(PROVIDER_ID);
      }
      if (typeof parsed.data?.biz_code === "number") {
        message = `DeepSeek biz error ${parsed.data.biz_code}: ${parsed.data.biz_msg ?? ""}`;
      } else if (parsed.msg) {
        message = parsed.msg;
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      // not JSON — keep the raw message
    }

    throw new ProviderError(PROVIDER_ID, message, status);
  }

  // ─── Proof of work ────────────────────────────────────────────────────────

  private async createPowHeader(
    auth: DeepSeekAuthState,
    targetPath: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const json = await this.requestJson(
      CREATE_POW_CHALLENGE_PATH,
      auth,
      { target_path: targetPath },
      abortSignal,
    );

    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) {
      throw new ProviderError(
        PROVIDER_ID,
        `PoW challenge not received: ${JSON.stringify(json).slice(0, 220)}`,
      );
    }
    if (challenge.algorithm !== "DeepSeekHashV1") {
      throw new ProviderError(
        PROVIDER_ID,
        `Unsupported PoW algorithm: ${challenge.algorithm}`,
      );
    }

    const expireAt = challenge.expire_at ?? challenge.expireAt;
    if (!Number.isFinite(expireAt)) {
      throw new ProviderError(PROVIDER_ID, "PoW challenge without expire_at");
    }

    const solver = await getWasmSolver();
    const answer = solver.calculateHash(
      challenge.challenge,
      challenge.salt,
      Number(challenge.difficulty),
      Number(expireAt),
    );
    if (!Number.isInteger(answer)) {
      throw new ProviderError(
        PROVIDER_ID,
        "PoW solver returned an invalid answer",
      );
    }

    return Buffer.from(
      JSON.stringify({
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer,
        signature: challenge.signature,
        target_path: targetPath,
      }),
      "utf8",
    ).toString("base64");
  }

  // ─── Plain JSON endpoints ─────────────────────────────────────────────────

  private async requestJson(
    path: string,
    auth: DeepSeekAuthState,
    body: unknown,
    abortSignal?: AbortSignal,
  ): Promise<DeepSeekResponseJson> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: this.buildHeaders(auth),
      body: JSON.stringify(body),
      signal: abortSignal,
    });

    const text = await response.text().catch(() => "");
    let json: DeepSeekResponseJson;
    try {
      json = JSON.parse(text) as DeepSeekResponseJson;
    } catch {
      throwForStatus(PROVIDER_ID, response);
      throw new ProviderError(
        PROVIDER_ID,
        `Invalid JSON from DeepSeek (${path}), status=${response.status}`,
        response.status,
      );
    }

    throwForStatus(PROVIDER_ID, response);

    if ([json.code, json.data?.code].some((c) => c === 40002 || c === 40003)) {
      throw new AuthExpiredError(PROVIDER_ID);
    }

    const bizCode = json.data?.biz_code;
    if (typeof bizCode === "number" && bizCode !== 0) {
      throw new ProviderError(
        PROVIDER_ID,
        `DeepSeek biz error ${bizCode}: ${json.data?.biz_msg ?? ""}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new ProviderError(
        PROVIDER_ID,
        `HTTP ${response.status}: ${text.slice(0, 220)}`,
        response.status,
      );
    }

    return json;
  }

  private buildHeaders(auth: DeepSeekAuthState): Record<string, string> {
    return {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      Cookie: auth.cookieHeader,
      "X-App-Version": APP_VERSION,
      "x-client-platform": "web",
      "x-client-version": APP_VERSION,
      "x-client-locale": "en",
      "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
      // Cookies alone are not enough: without the Bearer the API answers 40002.
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    };
  }
}

// ─── Delta extraction ───────────────────────────────────────────────────────

const CONTENT_PATH_RE = /\/(content|text|answer)$/i;
const THINKING_PATH_RE =
  /\/(reasoning_content|reasoning|thinking|thinking_content|reasoning_text)$/i;
/** `response/fragments/<N>/content`, where N may be negative (-1 = last). */
const FRAGMENT_PATH_RE = /\/fragments\/(-?\d+)\/content$/i;
const THINK_TYPE_RE = /^(think|reason|reasoning|cot|thinking)$/i;
const THINKING_FIELD_RE =
  /^(reasoning|reasoning_content|reasoning_text|thinking|thinking_content|thought|thoughts|cot)$/i;
const CONTENT_CARRIER_TYPES = [
  "response",
  "template_response",
  "answer",
  "assistant",
  "text",
  "message",
];

/**
 * Walks a DeepSeek SSE payload and pulls out the new text / reasoning. The
 * format is a patch stream (`{p, o, v}`) mixed with plain snapshots, so the
 * cache stores what was already emitted per path and only the delta is returned.
 */
function extractDelta(
  value: unknown,
  cache: Map<string, string>,
  state: PatchState,
): { text: string; thinking: string; messageId: number | null } {
  let messageId: number | null = null;
  let text = "";
  let thinking = "";

  const append = (target: PatchTarget, delta: string) => {
    if (target === "thinking") thinking += delta;
    else text += delta;
  };

  /** Emits only what is new compared to the previous snapshot of this key. */
  const appendSnapshot = (
    key: string,
    current: string,
    target: PatchTarget,
  ) => {
    const previous = cache.get(key) ?? "";
    const delta = current.startsWith(previous)
      ? current.slice(previous.length)
      : current;
    cache.set(key, current);
    if (delta) append(target, delta);
  };

  const targetForPath = (path: string): PatchTarget | undefined => {
    const fragment = FRAGMENT_PATH_RE.exec(path);
    if (fragment) {
      const raw = Number(fragment[1]);
      const list = state.fragmentTargets;
      // Fragment type not registered yet — fall back to the active target.
      return list[raw < 0 ? list.length + raw : raw] ?? state.lastTarget;
    }
    if (THINKING_PATH_RE.test(path)) return "thinking";
    if (CONTENT_PATH_RE.test(path)) return "text";
    return undefined;
  };

  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    for (const raw of [obj.response_message_id, obj.message_id]) {
      const id = toFiniteNumber(raw);
      if (id !== null) messageId = id;
    }
    const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "";
    if (role === "assistant") {
      const id = toFiniteNumber(obj.id);
      if (id !== null) messageId = id;
    }

    // Abbreviated patch `{"v":"…"}` with no path: continues the previous APPEND.
    // Happens at any depth (inside BATCH too), hence no path check.
    if (Object.keys(obj).length === 1 && typeof obj.v === "string") {
      append(state.lastTarget, obj.v);
      return;
    }

    // Fragment registration comes before the APPEND branch so the target of the
    // content that follows is already known:
    //   {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE"|"THINK"}]}
    if (
      obj.o === "APPEND" &&
      obj.p === "response/fragments" &&
      Array.isArray(obj.v)
    ) {
      obj.v.forEach((fragment, i) => {
        if (!fragment || typeof fragment !== "object") return;
        const frag = fragment as Record<string, unknown>;
        const type = typeof frag.type === "string" ? frag.type : "";
        const target: PatchTarget = THINK_TYPE_RE.test(type)
          ? "thinking"
          : "text";

        state.fragmentTargets.push(target);
        state.lastTarget = target;

        if (typeof frag.content === "string" && frag.content) {
          const id = frag.id === undefined ? `idx-${i}` : String(frag.id);
          appendSnapshot(
            `${messageId ?? "unknown"}:${path}:fragment:${id}:content`,
            frag.content,
            target,
          );
        }
      });
      return;
    }

    if (obj.o === "BATCH" && Array.isArray(obj.v)) {
      obj.v.forEach((item, idx) => visit(item, `${path}.v.${idx}`));
      return;
    }

    // Path patches. `o` may be missing entirely — then it inherits the previous
    // operation, which is an append.
    if (typeof obj.p === "string" && typeof obj.v === "string") {
      const target = targetForPath(obj.p);
      if (target) {
        state.lastTarget = target;
        if (typeof obj.o === "string" && obj.o !== "APPEND") {
          appendSnapshot(
            `${messageId ?? "unknown"}:${path}:${obj.p}`,
            obj.v,
            target,
          );
        } else {
          append(target, obj.v);
        }
        return;
      }
    }

    if (
      typeof obj.content === "string" &&
      (typeof obj.type === "string" || role === "assistant")
    ) {
      const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
      const phase =
        typeof obj.phase === "string" ? obj.phase.toLowerCase() : "";
      const key = `${messageId ?? "unknown"}:${path}:${type || role || "content"}`;

      if (THINK_TYPE_RE.test(type) || phase === "think") {
        appendSnapshot(key, obj.content, "thinking");
      } else if (CONTENT_CARRIER_TYPES.includes(type) || role === "assistant") {
        appendSnapshot(key, obj.content, "text");
      }
    }

    if (typeof obj.text === "string") {
      appendSnapshot(
        `${messageId ?? "unknown"}:${path}:text`,
        obj.text,
        "text",
      );
    }

    if (obj.delta && typeof obj.delta === "object") {
      const delta = obj.delta as Record<string, unknown>;
      const isThinkPhase =
        typeof obj.phase === "string" && obj.phase.toLowerCase() === "think";
      for (const field of [
        "content",
        "reasoning_content",
        "thinking",
        "reasoning",
        "text",
        "answer",
      ]) {
        const val = delta[field];
        if (typeof val !== "string") continue;
        const target: PatchTarget =
          THINKING_FIELD_RE.test(field) || (field === "content" && isThinkPhase)
            ? "thinking"
            : "text";
        appendSnapshot(
          `${messageId ?? "unknown"}:${path}:delta:${field}`,
          val,
          target,
        );
      }
    }

    const choice = Array.isArray(obj.choices) ? obj.choices[0] : undefined;
    if (choice && typeof choice === "object") {
      const delta = (choice as { delta?: Record<string, unknown> }).delta ?? {};
      if (typeof delta.content === "string") text += delta.content;
      if (typeof delta.reasoning_content === "string") {
        thinking += delta.reasoning_content;
      }
    }

    if (Array.isArray(node)) {
      node.forEach((item, idx) => visit(item, `${path}.${idx}`));
      return;
    }

    // `content`, `choices` and `delta` are fully handled above; descending into
    // them again would emit the same reasoning text a second time.
    for (const [key, item] of Object.entries(obj)) {
      if (key === "content" || key === "choices" || key === "delta") continue;
      if (typeof item === "string") {
        if (THINKING_FIELD_RE.test(key)) {
          appendSnapshot(
            `${messageId ?? "unknown"}:${path}:field:${key}`,
            item,
            "thinking",
          );
        }
        continue;
      }
      visit(item, `${path}.${key}`);
    }
  };

  visit(value, "$");
  return { text, thinking, messageId };
}

function toFiniteNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// ─── PoW solver (wasm) ──────────────────────────────────────────────────────

type DeepSeekWasmExports = {
  memory: WebAssembly.Memory;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  __wbindgen_export_0(size: number, align: number): number;
  __wbindgen_export_1(
    ptr: number,
    oldSize: number,
    newSize: number,
    align: number,
  ): number;
  wasm_solve(
    retptr: number,
    ptr0: number,
    len0: number,
    ptr1: number,
    len1: number,
    difficulty: number,
  ): void;
};

let wasmSolverPromise: Promise<DeepSeekHash> | undefined;

function getWasmSolver(): Promise<DeepSeekHash> {
  wasmSolverPromise ??= DeepSeekHash.create(DEEPSEEK_SHA3_WASM);
  return wasmSolverPromise;
}

/** Port of DeepSeek's own wasm-bindgen glue for the sha3 PoW challenge. */
class DeepSeekHash {
  private offset = 0;
  private cachedMemory: Uint8Array | null = null;
  private readonly encoder = new TextEncoder();

  private constructor(private readonly wasm: DeepSeekWasmExports) {}

  static async create(wasmUrl: string): Promise<DeepSeekHash> {
    const res = await fetch(wasmUrl);
    if (!res.ok) {
      throw new Error(`Failed to load PoW WASM: HTTP ${res.status}`);
    }
    const { instance } = await WebAssembly.instantiate(
      await res.arrayBuffer(),
      {
        wbg: {},
      },
    );
    return new DeepSeekHash(instance.exports as unknown as DeepSeekWasmExports);
  }

  calculateHash(
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number,
  ): number | undefined {
    const retptr = this.wasm.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr0 = this.encodeString(challenge);
      const len0 = this.offset;
      const ptr1 = this.encodeString(`${salt}_${expireAt}_`);
      const len1 = this.offset;

      this.wasm.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);
      const view = new DataView(this.wasm.memory.buffer);
      const status = view.getInt32(retptr, true);
      return status === 0 ? undefined : view.getFloat64(retptr + 8, true);
    } finally {
      this.wasm.__wbindgen_add_to_stack_pointer(16);
    }
  }

  private memory(): Uint8Array {
    if (!this.cachedMemory || this.cachedMemory.byteLength === 0) {
      this.cachedMemory = new Uint8Array(this.wasm.memory.buffer);
    }
    return this.cachedMemory;
  }

  private encodeString(text: string): number {
    const strLength = text.length;
    let ptr = this.wasm.__wbindgen_export_0(strLength, 1) >>> 0;
    const memory = this.memory();
    let written = 0;

    for (; written < strLength; written++) {
      const charCode = text.charCodeAt(written);
      if (charCode > 127) break;
      memory[ptr + written] = charCode;
    }

    if (written !== strLength) {
      const tail = written > 0 ? text.slice(written) : text;
      const capacity = written + tail.length * 3;
      ptr = this.wasm.__wbindgen_export_1(ptr, strLength, capacity, 1) >>> 0;
      const result = this.encoder.encodeInto(
        tail,
        this.memory().subarray(ptr + written, ptr + capacity),
      );
      written += result.written;
      ptr = this.wasm.__wbindgen_export_1(ptr, capacity, written, 1) >>> 0;
    }

    this.offset = written;
    return ptr;
  }
}
