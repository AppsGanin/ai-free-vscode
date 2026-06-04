import * as vscode from "vscode";
import { log } from "../../logger";
import { supportsThinking } from "../common/ModelCapabilities";
import {
  buildToolsSystemPrompt,
  findToolCallMarkerStart,
  parseToolCallsFromText,
  selectToolsForPrompt,
} from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
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
const APP_VERSION = "1.0.2";
const DEEPSEEK_SHA3_WASM =
  "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

const STREAM_TIMEOUT_MS = 30000;
const TOOL_MARKER_HOLDBACK_CHARS = 11;
// Если hold-буфер вырос настолько — это почти наверняка ложное срабатывание
// маркера (обычный markdown/код), а не tool call. Сбрасываем как текст, чтобы
// не ждать конца SSE-потока.
const MAX_TOOLCALL_HOLD_BUFFER_CHARS = 4096;

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
    msg?: string;
    biz_code?: number;
    biz_msg?: string;
    biz_data?: {
      id?: string;
      chat_session?: { id?: string };
      challenge?: PowChallenge;
      [key: string]: unknown;
    };
  };
}

let wasmSolverPromise: Promise<DeepSeekHash> | undefined;

function stripDanglingToolCallMarkers(text: string): string {
  return text
    .replace(/```tool_call\s*```?/gi, "")
    .replace(/```tool_call\s*$/gim, "")
    .replace(/^\s*```tool_call\s*\n?/gim, "")
    .replace(/^\s*<tool_call>\s*$/gim, "")
    .trim();
}

function sanitizeProtocolTranscript(text: string): string {
  if (!text) return "";

  let sanitized = text;

  // Убираем fenced tool_call блоки целиком, но оставляем разделители,
  // чтобы текст до/после не склеивался.
  sanitized = sanitized.replace(/```tool_call[\s\S]*?```/gi, "\n\n");
  // Убираем XML-подобный формат.
  sanitized = sanitized.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "\n\n");
  // Убираем JSON-объекты tool-call формата (name + arguments), сохраняя пробел.
  sanitized = sanitized.replace(
    /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g,
    " ",
  );
  // Фолбэк: когда JSON tool_call приходит одной строкой и содержит фигурные скобки
  // внутри строковых значений (старый regex может не покрыть все случаи).
  sanitized = sanitized.replace(
    /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{.*\}\s*\}\s*$/gim,
    "\n",
  );

  // Убираем явные служебные строки, не трогая прочий текст.
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
  sanitized = sanitized.replace(/^\s*tool_call\s*$/gim, "\n");
  sanitized = sanitized.replace(/^\s*Tool:\s.*$/gim, "\n");
  sanitized = sanitized.replace(/^\s*User:\s*Tool result:.*$/gim, "\n");
  sanitized = sanitized.replace(/^\s*User:\s*\[call_[^\]]+\].*$/gim, "\n");
  sanitized = sanitized.replace(
    /^\s*\/Users\/[^\n]*chat-session-resources[^\n]*$/gim,
    "\n",
  );
  // Если модель начала печатать роль Assistant, оставляем только контент.
  sanitized = sanitized.replace(/^\s*Assistant:\s?/gim, "");

  // Мягкая нормализация без trim(), чтобы не срезать стартовые пробелы/символы чанка.
  // Убираем только полностью пустые markdown code fences.
  sanitized = sanitized.replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n");

  sanitized = sanitized.replace(/[ \t]{2,}/g, " ");
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");

  return sanitized;
}

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

export class DeepSeekApiClient {
  async createSession(
    auth: DeepSeekAuthState,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const json = await this.requestJson(CREATE_SESSION_PATH, {
      method: "POST",
      auth,
      body: {},
      abortSignal,
    });

    const biz = json?.data?.biz_data;
    const sessionId = biz?.id ?? biz?.chat_session?.id;
    if (!sessionId) {
      throw new ProviderError(
        PROVIDER_ID,
        `Не удалось получить id сессии DeepSeek: ${JSON.stringify(json).slice(0, 250)}`,
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
        "Отсутствует session_id для запроса",
      );
    }

    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;

    let toolsPrompt: string | undefined;
    if (hasTools && params.tools?.length) {
      const selectedTools = selectToolsForPrompt(
        params.tools,
        this.contentToString(
          params.messages[params.messages.length - 1]?.content ?? "",
        ),
        params.toolMode,
      );
      toolsPrompt = buildToolsSystemPrompt(selectedTools);
    }

    const prompt = this.buildPromptFromMessages(params.messages, toolsPrompt);
    const parentMessageId = this.parseParentMessageId(params.parentId);
    const resolvedModelId = resolveDeepSeekModelId(params.model);
    const modelType = toDeepSeekApiModelType(resolvedModelId);
    const thinkingConfig = this.resolveThinkingConfig(
      resolvedModelId,
      hasTools,
    );
    log(
      `[deepseek-api] thinking mode=${thinkingConfig.mode} enabled=${thinkingConfig.enabled} hasTools=${hasTools} model=${resolvedModelId}`,
    );

    const powHeader = await this.createPowHeader(
      auth,
      COMPLETION_PATH,
      params.abortSignal,
    );

    const response = await fetch(`${BASE_URL}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        ...this.buildHeaders(auth),
        "X-DS-PoW-Response": powHeader,
      },
      body: JSON.stringify({
        chat_session_id: sessionId,
        parent_message_id: parentMessageId ?? null,
        model_type: modelType,
        preempt: false,
        prompt,
        ref_file_ids: [],
        thinking_enabled: thinkingConfig.enabled,
        search_enabled: false,
      }),
      signal: params.abortSignal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthExpiredError(PROVIDER_ID);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(
        PROVIDER_ID,
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }

    const contentType = String(response.headers.get("content-type") || "");
    if (!response.ok || !contentType.includes("text/event-stream")) {
      const txt = await response.text().catch(() => "");
      this.throwCompletionHttpError(response.status, txt);
    }

    if (!response.body) {
      throw new ProviderError(PROVIDER_ID, "Response body is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    let lastActivityAt = Date.now();
    const fragments = new Map<string, string>();
    let parsedEventsCount = 0;
    let emittedTextChunks = 0;
    let emittedThinkingChunks = 0;
    let pendingBuffer = "";
    let toolCallHoldBuffer = "";
    let toolCallHoldActive = false;

    const routeTextChunk = function* (
      rawText: string,
    ): Iterable<AIStreamChunk> {
      if (!rawText) {
        return;
      }

      if (!allowToolCalls) {
        emittedTextChunks++;
        yield { type: "text", content: rawText };
        return;
      }

      if (toolCallHoldActive) {
        toolCallHoldBuffer += rawText;
        if (toolCallHoldBuffer.length >= MAX_TOOLCALL_HOLD_BUFFER_CHARS) {
          const sanitized = stripDanglingToolCallMarkers(toolCallHoldBuffer);
          if (sanitized) {
            emittedTextChunks++;
            yield { type: "text", content: sanitized };
          }
          toolCallHoldBuffer = "";
          toolCallHoldActive = false;
        }
        return;
      }

      pendingBuffer += rawText;
      const markerIdx = findToolCallMarkerStart(pendingBuffer);

      if (markerIdx !== -1) {
        const safeText = pendingBuffer.slice(0, markerIdx);
        if (safeText) {
          emittedTextChunks++;
          yield { type: "text", content: safeText };
        }
        toolCallHoldBuffer = pendingBuffer.slice(markerIdx);
        pendingBuffer = "";
        toolCallHoldActive = true;
      } else if (pendingBuffer.length > TOOL_MARKER_HOLDBACK_CHARS) {
        const safeText = pendingBuffer.slice(
          0,
          pendingBuffer.length - TOOL_MARKER_HOLDBACK_CHARS,
        );
        if (safeText) {
          emittedTextChunks++;
          yield { type: "text", content: safeText };
        }
        pendingBuffer = pendingBuffer.slice(
          pendingBuffer.length - TOOL_MARKER_HOLDBACK_CHARS,
        );
      }
    };

    const throwIfTimedOut = () => {
      if (Date.now() - lastActivityAt > STREAM_TIMEOUT_MS) {
        throw new ProviderError(PROVIDER_ID, "Таймаут стрима DeepSeek");
      }
    };

    const findEventBoundary = (
      input: string,
    ): { index: number; separatorLength: number } | undefined => {
      const lfIndex = input.indexOf("\n\n");
      const crlfIndex = input.indexOf("\r\n\r\n");

      if (lfIndex === -1 && crlfIndex === -1) {
        return undefined;
      }

      if (lfIndex === -1) {
        return { index: crlfIndex, separatorLength: 4 };
      }
      if (crlfIndex === -1) {
        return { index: lfIndex, separatorLength: 2 };
      }

      return lfIndex < crlfIndex
        ? { index: lfIndex, separatorLength: 2 }
        : { index: crlfIndex, separatorLength: 4 };
    };

    try {
      while (true) {
        throwIfTimedOut();
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }
        if (value?.length) {
          lastActivityAt = Date.now();
        }

        buffer += decoder.decode(value, { stream: true });

        let boundary = findEventBoundary(buffer);
        while (boundary) {
          const rawEvent = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.separatorLength);

          const event = this.parseSseEvent(rawEvent);
          if (!event.data) {
            boundary = findEventBoundary(buffer);
            continue;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
            parsedEventsCount++;
          } catch {
            boundary = findEventBoundary(buffer);
            continue;
          }

          this.throwIfSseBizError(parsed);

          const { text, thinking, messageId } = this.extractDeltaText(
            parsed,
            fragments,
          );
          if (typeof messageId === "number") {
            options?.onMessageId?.(messageId);
          }
          if (thinking) {
            emittedThinkingChunks++;
            yield { type: "thinking", content: thinking };
          }
          if (text) {
            yield* routeTextChunk(text);
          }

          boundary = findEventBoundary(buffer);
        }
      }

      // Разбираем возможные события, оставшиеся после финального decoder.decode().
      let tailBoundary = findEventBoundary(buffer);
      while (tailBoundary) {
        const rawEvent = buffer.slice(0, tailBoundary.index);
        buffer = buffer.slice(
          tailBoundary.index + tailBoundary.separatorLength,
        );

        const event = this.parseSseEvent(rawEvent);
        if (!event.data) {
          tailBoundary = findEventBoundary(buffer);
          continue;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
          parsedEventsCount++;
        } catch {
          tailBoundary = findEventBoundary(buffer);
          continue;
        }

        this.throwIfSseBizError(parsed);

        const { text, thinking, messageId } = this.extractDeltaText(
          parsed,
          fragments,
        );
        if (typeof messageId === "number") {
          options?.onMessageId?.(messageId);
        }
        if (thinking) {
          emittedThinkingChunks++;
          yield { type: "thinking", content: thinking };
        }
        if (text) {
          yield* routeTextChunk(text);
        }

        tailBoundary = findEventBoundary(buffer);
      }

      // Финальный частичный эвент без двойного перевода строки.
      if (buffer.trim()) {
        const event = this.parseSseEvent(buffer);
        if (event.data) {
          try {
            const parsed = JSON.parse(event.data);
            parsedEventsCount++;
            this.throwIfSseBizError(parsed);
            const { text, thinking, messageId } = this.extractDeltaText(
              parsed,
              fragments,
            );
            if (typeof messageId === "number") {
              options?.onMessageId?.(messageId);
            }
            if (thinking) {
              emittedThinkingChunks++;
              yield { type: "thinking", content: thinking };
            }
            if (text) {
              yield* routeTextChunk(text);
            }
          } catch {
            // ignore trailing non-json tail
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    if (allowToolCalls) {
      // Текст, удержанный маркером (потенциальный tool call), и обычный
      // holdback-хвост разделяем явно. Сбрасываем состояние, чтобы прямые yield
      // ниже не попали обратно в hold-буфер.
      const holdBuffer = toolCallHoldActive ? toolCallHoldBuffer : "";
      const tailText = toolCallHoldActive ? "" : pendingBuffer;
      pendingBuffer = "";
      toolCallHoldBuffer = "";
      toolCallHoldActive = false;

      if (holdBuffer) {
        const parsedChunks = Array.from(parseToolCallsFromText(holdBuffer));
        const toolChunks = parsedChunks.filter((c) => c.type === "tool_call");
        const sanitizedTextRemainder = sanitizeProtocolTranscript(
          stripDanglingToolCallMarkers(holdBuffer),
        );

        if (toolChunks.length > 0) {
          for (const chunk of toolChunks) {
            yield chunk;
          }

          // DeepSeek может присылать обычный текст рядом с tool call. Отдаём
          // очищенный остаток НАПРЯМУЮ — через routeTextChunk он бы снова попал
          // в hold-буфер и потерялся.
          if (sanitizedTextRemainder) {
            emittedTextChunks++;
            yield { type: "text", content: sanitizedTextRemainder };
          }
        } else {
          // Ложное срабатывание маркера. Если очистка оставила пусто —
          // отдаём исходный буфер, чтобы не получить пустой ответ.
          const textOut = sanitizedTextRemainder || holdBuffer.trim();
          if (textOut) {
            emittedTextChunks++;
            yield { type: "text", content: textOut };
          }
        }
      }

      // Обычный holdback-хвост (без маркера) отдаём как есть.
      if (tailText) {
        emittedTextChunks++;
        yield { type: "text", content: tailText };
      }
      return;
    }

    if (
      parsedEventsCount > 0 &&
      emittedTextChunks === 0 &&
      emittedThinkingChunks === 0
    ) {
      log(
        `[deepseek-api] stream completed without text chunks model=${modelType} parsedEvents=${parsedEventsCount} allowToolCalls=${allowToolCalls}`,
      );
    }

    if (thinkingConfig.enabled && emittedThinkingChunks === 0) {
      log(
        `[deepseek-api] thinking enabled but no thinking chunks received model=${modelType} hasTools=${hasTools} allowToolCalls=${allowToolCalls}`,
      );
    }
  }

  async stopStream(
    auth: DeepSeekAuthState,
    sessionId: string,
    messageId?: number,
  ): Promise<void> {
    const body: Record<string, unknown> = { chat_session_id: sessionId };
    if (typeof messageId === "number" && Number.isFinite(messageId)) {
      body.message_id = messageId;
    }

    await this.requestJson(STOP_STREAM_PATH, {
      method: "POST",
      auth,
      body,
      abortSignal: undefined,
    });
  }

  private parseParentMessageId(parentId?: string): number | undefined {
    if (!parentId) return undefined;
    const num = Number(parentId);
    return Number.isFinite(num) ? Math.floor(num) : undefined;
  }

  private resolveThinkingConfig(
    resolvedModelId: string,
    hasTools: boolean,
  ): {
    mode: "auto" | "on" | "off";
    enabled: boolean;
  } {
    const cfg = vscode.workspace.getConfiguration("freeAI.deepseek");
    const rawMode = String(cfg.get("thinkingMode", "auto")).toLowerCase();
    const mode: "auto" | "on" | "off" =
      rawMode === "on" || rawMode === "off" ? rawMode : "auto";

    const thinkingSupported = supportsThinking(
      DEEPSEEK_MODELS,
      resolvedModelId,
    );
    const enabled = thinkingSupported
      ? mode === "on"
        ? true
        : mode === "off"
          ? false
          : !hasTools
      : false;

    return { mode, enabled };
  }

  private buildPromptFromMessages(
    messages: AIMessage[],
    toolsPrompt?: string,
  ): string {
    const parts: string[] = [];

    if (toolsPrompt) {
      parts.push(`System: ${toolsPrompt}`);
    }

    for (const msg of messages) {
      if (msg.role === "system") continue;
      const content = this.contentToString(msg.content).trim();
      if (!content) continue;
      const roleLabel = msg.role === "assistant" ? "Assistant" : "User";
      parts.push(`${roleLabel}: ${content}`);
    }

    if (parts.length === 0) {
      return "Assistant:";
    }

    return `${parts.join("\n\n")}\n\nAssistant:`;
  }

  private contentToString(content: AIMessage["content"]): string {
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((part) => (part.type === "text" ? part.text : "[image]"))
      .join("\n");
  }

  private parseSseEvent(raw: string): { event: string; data: string } {
    const event = { event: "", data: "" };
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        event.event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        event.data += (event.data ? "\n" : "") + line.slice(5).trimStart();
      }
    }
    return event;
  }

  private extractDeltaText(
    value: unknown,
    cache: Map<string, string>,
  ): { text: string; thinking: string; messageId: number | null } {
    let messageId: number | null = null;
    let text = "";
    let thinking = "";
    const contentPathRe = /\/(content|text|answer)$/i;
    const thinkingPathRe =
      /\/(reasoning_content|reasoning|thinking|thinking_content|reasoning_text)$/i;
    const thinkTypeRe = /^(think|reason|reasoning|cot)$/i;
    const thinkingFieldRe =
      /^(reasoning|reasoning_content|reasoning_text|thinking|thinking_content|thought|thoughts|cot)$/i;

    const appendCached = (
      cacheKey: string,
      current: string,
      target: "text" | "thinking",
    ) => {
      const previous = cache.get(cacheKey) ?? "";
      const delta = current.startsWith(previous)
        ? current.slice(previous.length)
        : current;
      cache.set(cacheKey, current);
      if (delta) {
        if (target === "thinking") {
          thinking += delta;
        } else {
          text += delta;
        }
      }
    };

    const readNumericId = (raw: unknown): number | null => {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        return raw;
      }
      if (typeof raw === "string" && raw.trim().length > 0) {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return null;
    };

    const visit = (node: unknown, path: string): void => {
      if (!node || typeof node !== "object") return;

      const obj = node as Record<string, unknown>;

      const responseMessageId = readNumericId(obj.response_message_id);
      if (responseMessageId !== null) {
        messageId = responseMessageId;
      }
      const rawMessageId = readNumericId(obj.message_id);
      if (rawMessageId !== null) {
        messageId = rawMessageId;
      }
      const normalizedRole =
        typeof obj.role === "string" ? obj.role.toLowerCase() : "";
      const rawId = readNumericId(obj.id);
      if (rawId !== null && normalizedRole === "assistant") {
        messageId = rawId;
      }

      if (
        path === "$" &&
        Object.keys(obj).length === 1 &&
        typeof obj.v === "string"
      ) {
        text += obj.v;
        return;
      }

      if (
        obj.o === "APPEND" &&
        typeof obj.p === "string" &&
        typeof obj.v === "string"
      ) {
        if (thinkingPathRe.test(obj.p)) {
          thinking += obj.v;
          return;
        }
        if (contentPathRe.test(obj.p)) {
          text += obj.v;
          return;
        }
        return;
      }

      // DeepSeek patch-формат перехода think -> response часто идёт как:
      // 1) {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE"|"THINK", ...}]}
      // 2) {"p":"response/fragments/-1/content","v":"..."}
      if (
        obj.o === "APPEND" &&
        obj.p === "response/fragments" &&
        Array.isArray(obj.v)
      ) {
        for (let i = 0; i < obj.v.length; i++) {
          const fragment = obj.v[i];
          if (!fragment || typeof fragment !== "object") continue;
          const frag = fragment as Record<string, unknown>;
          const content = typeof frag.content === "string" ? frag.content : "";
          const type =
            typeof frag.type === "string" ? frag.type.toLowerCase() : "";
          const target: "text" | "thinking" =
            thinkTypeRe.test(type) || type === "thinking" ? "thinking" : "text";

          if (!content) continue;

          const fragId =
            typeof frag.id === "number" || typeof frag.id === "string"
              ? String(frag.id)
              : `idx-${i}`;
          const key = `${messageId ?? "unknown"}:${path}:fragment:${fragId}:content`;
          appendCached(key, content, target);
        }
        return;
      }

      if (
        typeof obj.o === "string" &&
        ["SET", "REPLACE", "UPDATE", "INSERT"].includes(obj.o) &&
        typeof obj.p === "string" &&
        typeof obj.v === "string"
      ) {
        const key = `${messageId ?? "unknown"}:${path}:${obj.p}`;

        if (thinkingPathRe.test(obj.p)) {
          appendCached(key, obj.v, "thinking");
          return;
        }
        if (contentPathRe.test(obj.p)) {
          appendCached(key, obj.v, "text");
          return;
        }
        return;
      }

      if (obj.o === "BATCH" && Array.isArray(obj.v)) {
        obj.v.forEach((item, idx) => visit(item, `${path}.v.${idx}`));
        return;
      }

      if (
        typeof obj.content === "string" &&
        (typeof obj.type === "string" || normalizedRole === "assistant")
      ) {
        const normalizedType =
          typeof obj.type === "string" ? obj.type.toLowerCase() : "";
        const isContentCarrierType = [
          "response",
          "template_response",
          "answer",
          "assistant",
          "text",
          "message",
        ].includes(normalizedType);
        const isThinkingCarrierType =
          thinkTypeRe.test(normalizedType) ||
          normalizedType === "thinking" ||
          normalizedType === "reasoning";
        const normalizedPhase =
          typeof obj.phase === "string" ? obj.phase.toLowerCase() : "";
        const isThinkPhase = normalizedPhase === "think";

        if (isThinkingCarrierType || isThinkPhase) {
          const key = `${messageId ?? "unknown"}:${path}:${normalizedType || normalizedRole || "content"}`;
          appendCached(key, obj.content, "thinking");
        } else if (isContentCarrierType || normalizedRole === "assistant") {
          const key = `${messageId ?? "unknown"}:${path}:${normalizedType || normalizedRole || "content"}`;
          appendCached(key, obj.content, "text");
        }
      }

      if (typeof obj.text === "string") {
        const key = `${messageId ?? "unknown"}:${path}:text`;
        appendCached(key, obj.text, "text");
      }

      if (typeof obj.reasoning_content === "string") {
        const key = `${messageId ?? "unknown"}:${path}:reasoning_content`;
        appendCached(key, obj.reasoning_content, "thinking");
      }

      if (typeof obj.reasoning === "string") {
        const key = `${messageId ?? "unknown"}:${path}:reasoning`;
        appendCached(key, obj.reasoning, "thinking");
      }

      if (typeof obj.thinking === "string") {
        const key = `${messageId ?? "unknown"}:${path}:thinking`;
        appendCached(key, obj.thinking, "thinking");
      }

      if (typeof obj.thinking_content === "string") {
        const key = `${messageId ?? "unknown"}:${path}:thinking_content`;
        appendCached(key, obj.thinking_content, "thinking");
      }

      if (obj.delta && typeof obj.delta === "object") {
        const deltaObj = obj.delta as Record<string, unknown>;
        const normalizedPhase =
          typeof obj.phase === "string" ? obj.phase.toLowerCase() : "";
        const isThinkPhase = normalizedPhase === "think";
        for (const field of [
          "content",
          "reasoning_content",
          "thinking",
          "reasoning",
          "text",
          "answer",
        ]) {
          const val = deltaObj[field];
          if (typeof val === "string") {
            const key = `${messageId ?? "unknown"}:${path}:delta:${field}`;
            const target =
              field === "reasoning_content" ||
              field === "thinking" ||
              field === "reasoning" ||
              (field === "content" && isThinkPhase)
                ? "thinking"
                : "text";
            appendCached(key, val, target);
          }
        }
      }

      const maybeChoices = obj.choices;
      if (
        Array.isArray(maybeChoices) &&
        maybeChoices[0] &&
        typeof maybeChoices[0] === "object"
      ) {
        const c0 = maybeChoices[0] as {
          delta?: { content?: unknown; reasoning_content?: unknown };
        };
        if (typeof c0.delta?.content === "string") {
          text += c0.delta.content;
        }
        if (typeof c0.delta?.reasoning_content === "string") {
          thinking += c0.delta.reasoning_content;
        }
      }

      if (Array.isArray(node)) {
        node.forEach((item, idx) => visit(item, `${path}.${idx}`));
        return;
      }

      for (const [key, item] of Object.entries(obj)) {
        if (key === "content" || key === "choices") {
          continue;
        }

        if (typeof item === "string" && thinkingFieldRe.test(key)) {
          const cacheKey = `${messageId ?? "unknown"}:${path}:field:${key}`;
          appendCached(cacheKey, item, "thinking");
          continue;
        }

        visit(item, `${path}.${key}`);
      }
    };

    visit(value, "$");
    return { text, thinking, messageId };
  }

  private throwIfSseBizError(parsed: unknown): void {
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const data = parsed as {
      biz_code?: unknown;
      biz_msg?: unknown;
      data?: { biz_code?: unknown; biz_msg?: unknown; biz_data?: unknown };
    };

    const codeRaw = data.data?.biz_code ?? data.biz_code;
    const msgRaw = data.data?.biz_msg ?? data.biz_msg;

    if (typeof codeRaw === "number" && codeRaw !== 0) {
      const msg = typeof msgRaw === "string" ? msgRaw : "Unknown error";
      throw new ProviderError(
        PROVIDER_ID,
        `DeepSeek biz error ${codeRaw}: ${msg}`,
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
      } else if (typeof parsed.msg === "string" && parsed.msg) {
        message = parsed.msg;
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        throw err;
      }
      // ignore parse errors
    }

    throw new ProviderError(PROVIDER_ID, message, status);
  }

  private async createPowHeader(
    auth: DeepSeekAuthState,
    targetPath: string,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const json = await this.requestJson(CREATE_POW_CHALLENGE_PATH, {
      method: "POST",
      auth,
      body: { target_path: targetPath },
      abortSignal,
    });

    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge) {
      throw new ProviderError(
        PROVIDER_ID,
        `PoW challenge не получен: ${JSON.stringify(json).slice(0, 220)}`,
      );
    }

    const answer = await this.solvePow(challenge);
    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: targetPath,
    };

    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  }

  private async requestJson(
    path: string,
    params: {
      method: "GET" | "POST";
      auth: DeepSeekAuthState;
      body?: unknown;
      abortSignal?: AbortSignal;
    },
  ): Promise<DeepSeekResponseJson> {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: params.method,
      headers: this.buildHeaders(params.auth),
      body: params.body === undefined ? undefined : JSON.stringify(params.body),
      signal: params.abortSignal,
    });

    const text = await response.text().catch(() => "");
    let json: DeepSeekResponseJson | undefined;

    try {
      json = JSON.parse(text) as DeepSeekResponseJson;
    } catch {
      if (response.status === 401 || response.status === 403) {
        throw new AuthExpiredError(PROVIDER_ID);
      }
      throw new ProviderError(
        PROVIDER_ID,
        `Некорректный JSON от DeepSeek (${path}), status=${response.status}`,
        response.status,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthExpiredError(PROVIDER_ID);
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(
        PROVIDER_ID,
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }

    if (
      json.code === 40002 ||
      json.code === 40003 ||
      json.data?.code === 40002 ||
      json.data?.code === 40003
    ) {
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
    const timezoneOffset = String(-new Date().getTimezoneOffset() * 60);
    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Content-Type": "application/json",
      Origin: BASE_URL,
      Referer: `${BASE_URL}/`,
      Cookie: auth.cookieHeader,
      "X-App-Version": APP_VERSION,
      "x-client-platform": "web",
      "x-client-version": APP_VERSION,
      "x-client-locale": "ru",
      "x-client-timezone-offset": timezoneOffset,
    };

    if (auth.token) {
      headers.Authorization = `Bearer ${auth.token}`;
    }

    return headers;
  }

  private async solvePow(challenge: PowChallenge): Promise<number> {
    if (challenge.algorithm !== "DeepSeekHashV1") {
      throw new ProviderError(
        PROVIDER_ID,
        `Неподдерживаемый PoW алгоритм: ${challenge.algorithm}`,
      );
    }

    const expireAt = challenge.expire_at ?? challenge.expireAt;
    if (!Number.isFinite(expireAt)) {
      throw new ProviderError(PROVIDER_ID, "PoW challenge без expire_at");
    }

    const solver = await this.getWasmSolver();
    const answer = solver.calculateHash(
      challenge.algorithm,
      challenge.challenge,
      challenge.salt,
      Number(challenge.difficulty),
      Number(expireAt),
    );

    if (typeof answer !== "number" || !Number.isInteger(answer)) {
      throw new ProviderError(
        PROVIDER_ID,
        "PoW solver вернул некорректный ответ",
      );
    }

    return answer;
  }

  private async getWasmSolver(): Promise<DeepSeekHash> {
    if (!wasmSolverPromise) {
      wasmSolverPromise = DeepSeekHash.create(DEEPSEEK_SHA3_WASM);
    }
    return wasmSolverPromise;
  }
}

class DeepSeekHash {
  private offset = 0;
  private cachedUint8Memory: Uint8Array | null = null;
  private readonly cachedTextEncoder = new TextEncoder();

  private constructor(private readonly wasmInstance: DeepSeekWasmExports) {}

  static async create(wasmUrl: string): Promise<DeepSeekHash> {
    const res = await fetch(wasmUrl);
    if (!res.ok) {
      throw new Error(`Failed to load PoW WASM: HTTP ${res.status}`);
    }
    const wasmBuffer = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    return new DeepSeekHash(instance.exports as unknown as DeepSeekWasmExports);
  }

  calculateHash(
    algorithm: string,
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number,
  ): number | undefined {
    if (algorithm !== "DeepSeekHashV1") {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const prefix = `${salt}_${expireAt}_`;
    const retptr = this.wasmInstance.__wbindgen_add_to_stack_pointer(-16);

    try {
      const ptr0 = this.encodeString(
        challenge,
        this.wasmInstance.__wbindgen_export_0.bind(this.wasmInstance),
        this.wasmInstance.__wbindgen_export_1.bind(this.wasmInstance),
      );
      const len0 = this.offset;

      const ptr1 = this.encodeString(
        prefix,
        this.wasmInstance.__wbindgen_export_0.bind(this.wasmInstance),
        this.wasmInstance.__wbindgen_export_1.bind(this.wasmInstance),
      );
      const len1 = this.offset;

      this.wasmInstance.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);
      const dataView = new DataView(this.wasmInstance.memory.buffer);
      const status = dataView.getInt32(retptr, true);
      const value = dataView.getFloat64(retptr + 8, true);
      return status === 0 ? undefined : value;
    } finally {
      this.wasmInstance.__wbindgen_add_to_stack_pointer(16);
    }
  }

  private getCachedUint8Memory(): Uint8Array {
    if (!this.cachedUint8Memory || this.cachedUint8Memory.byteLength === 0) {
      this.cachedUint8Memory = new Uint8Array(this.wasmInstance.memory.buffer);
    }
    return this.cachedUint8Memory;
  }

  private encodeString(
    text: string,
    allocate: (size: number, align: number) => number,
    reallocate: (
      ptr: number,
      oldSize: number,
      newSize: number,
      align: number,
    ) => number,
  ): number {
    const strLength = text.length;
    let ptr = allocate(strLength, 1) >>> 0;
    const memory = this.getCachedUint8Memory();
    let asciiLength = 0;

    for (; asciiLength < strLength; asciiLength += 1) {
      const charCode = text.charCodeAt(asciiLength);
      if (charCode > 127) {
        break;
      }
      memory[ptr + asciiLength] = charCode;
    }

    if (asciiLength !== strLength) {
      let tail = text;
      if (asciiLength > 0) {
        tail = text.slice(asciiLength);
      }

      ptr = reallocate(ptr, strLength, asciiLength + tail.length * 3, 1) >>> 0;
      const result = this.cachedTextEncoder.encodeInto(
        tail,
        this.getCachedUint8Memory().subarray(
          ptr + asciiLength,
          ptr + asciiLength + tail.length * 3,
        ),
      );
      asciiLength += result.written;
      ptr =
        reallocate(ptr, asciiLength + tail.length * 3, asciiLength, 1) >>> 0;
    }

    this.offset = asciiLength;
    return ptr;
  }
}
