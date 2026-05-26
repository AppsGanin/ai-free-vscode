/**
 * HTTP client for direct requests to the chat.qwen.ai API v2.
 * Uses node:https (like DeepSeekClient) to bypass VS Code's patched globalThis.fetch.
 *
 * Qwen API v2:
 *   POST https://chat.qwen.ai/api/v2/chats/new        — create a chat
 *   POST https://chat.qwen.ai/api/v2/chat/completions — stream response
 *
 * Auth: Bearer token from localStorage.getItem('token') on chat.qwen.ai.
 */

import { randomUUID } from "node:crypto";
import { httpsRequest, readBody } from "../../utils/https.mjs";
import {
  CHAT_API_PATH,
  CREATE_CHAT_PATH,
  BASE_URL as QWEN_BASE,
} from "./config.mjs";
import { baseHeaders } from "./headers.mjs";

export class QwenClient {
  constructor({ token, debug = false }) {
    this.token = token;
    this.debug = debug;
  }

  _headers(extra = {}) {
    return baseHeaders(this.token, extra);
  }

  /** Creates a new chat on Qwen servers, returns chatId. */
  async createChat(model = "qwen-max-latest", signal) {
    const body = JSON.stringify({
      title: "VS Code Chat",
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    });
    const headers = this._headers({
      "Content-Length": String(Buffer.byteLength(body)),
    });

    if (this.debug)
      console.error("[qwen] createChat →", `${QWEN_BASE}${CREATE_CHAT_PATH}`);

    const res = await httpsRequest(
      `${QWEN_BASE}${CREATE_CHAT_PATH}`,
      "POST",
      headers,
      body,
      signal,
    );
    const text = await readBody(res);

    if (this.debug)
      console.error(
        "[qwen] createChat HTTP",
        res.statusCode,
        text.slice(0, 300),
      );

    if (res.statusCode === 401 || res.statusCode === 403) {
      const err = new Error(`Qwen: auth error HTTP ${res.statusCode}`);
      err.isAuthError = true;
      throw err;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Qwen createChat: unexpected HTTP response ${res.statusCode}: ${text.slice(0, 200)}`,
      );
    }

    if (!data.success) {
      throw new Error(`Qwen createChat error: ${text.slice(0, 200)}`);
    }
    return data.data.id;
  }

  /**
   * Sends a prompt to Qwen and streams the response via onText().
   * @param {{ model: string, prompt: string, onText: (t:string)=>Promise<void>, onThinking?: (t:string)=>Promise<void>, signal: AbortSignal }} opts
   */
  async complete({
    model = "qwen-max-latest",
    chatId,
    prompt,
    onText,
    onThinking,
    signal,
  }) {
    const throwIfAborted = () => {
      if (!signal?.aborted) return;
      const err = new Error("Request aborted");
      err.name = "AbortError";
      err.code = "ABORT_ERR";
      throw err;
    };

    let stopRequested = false;
    const onAbort = () => {
      if (stopRequested) return;
      stopRequested = true;
      if (this.debug) {
        console.error("[qwen] abort signal received");
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (!chatId) {
      chatId = await this.createChat(model, signal);
      if (stopRequested) {
        throwIfAborted();
      }
    }

    try {
      const userMsgId = randomUUID();
      const childId = randomUUID();

      const thinkingEnabled = true;

      const payload = {
        stream: true,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: "normal",
        messages: [
          {
            fid: userMsgId,
            parentId: null,
            parent_id: null,
            role: "user",
            content: prompt,
            chat_type: "t2t",
            sub_chat_type: "t2t",
            timestamp: Math.floor(Date.now() / 1000),
            user_action: "chat",
            models: [model],
            files: [],
            childrenIds: [childId],
            extra: { meta: { subChatType: "t2t" } },
            feature_config: {
              thinking_enabled: thinkingEnabled,
              // Limit thinking tokens to prevent infinite reasoning loops.
              // The model can get stuck generating repeated tool-call plans in
              // the thinking phase; a budget forces it to transition to the
              // answer phase.
              ...(thinkingEnabled ? { thinking_budget_tokens: 8192 } : {}),
              // "phase" output schema buffers the entire thinking phase before
              // streaming content — only use it for reasoning models that
              // actually produce thinking output; for others it causes the whole
              // response to arrive at once after a long silent wait.
              ...(thinkingEnabled ? { output_schema: "phase" } : {}),
            },
          },
        ],
        model,
        parent_id: null,
        timestamp: Math.floor(Date.now() / 1000),
      };

      const body = JSON.stringify(payload);
      const headers = this._headers({
        "Content-Length": String(Buffer.byteLength(body)),
      });

      const apiUrl = `${QWEN_BASE}${CHAT_API_PATH}?chat_id=${chatId}`;
      if (this.debug) console.error("[qwen] complete →", apiUrl);

      const res = await httpsRequest(apiUrl, "POST", headers, body, signal);

      if (this.debug) {
        console.error(
          "[qwen] complete HTTP",
          res.statusCode,
          "content-type:",
          res.headers?.["content-type"],
        );
      }

      if (res.statusCode === 401 || res.statusCode === 403) {
        const err = new Error(
          `Qwen: session expired (HTTP ${res.statusCode}). Run «Qwen: Sign In».`,
        );
        err.isAuthError = true;
        throw err;
      }
      if (res.statusCode === 429) {
        const err = new Error("Qwen: rate limit exceeded.");
        err.isRateLimit = true;
        throw err;
      }
      if (res.statusCode >= 400) {
        const errBody = await readBody(res);
        if (this.debug)
          console.error("[qwen] error body:", errBody.slice(0, 500));
        throw new Error(
          `Qwen API HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`,
        );
      }

      const contentType = res.headers?.["content-type"] ?? "";

      // ── Non-streaming JSON response (fallback) ─────────────────
      if (!contentType.includes("event-stream")) {
        const rawBody = await readBody(res);
        if (this.debug)
          console.error("[qwen] non-sse body:", rawBody.slice(0, 500));
        let json;
        try {
          json = JSON.parse(rawBody);
        } catch {
          throw new Error(
            `Qwen: unexpected response: ${rawBody.slice(0, 200)}`,
          );
        }
        if (json?.success === false) {
          const code = json?.data?.code ?? "unknown";
          const details = json?.data?.details ?? json?.data?.message ?? "";
          throw new Error(
            `Qwen API error: ${code}${details ? ` — ${details}` : ""}`,
          );
        }
        const content =
          json?.choices?.[0]?.message?.content ??
          json?.data?.choices?.[0]?.message?.content ??
          "";
        if (content) onText?.(content);
        return content;
      }

      // ── SSE streaming ────────────────────────────────────────────
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let chunkCount = 0;

      for await (const chunk of res) {
        throwIfAborted();
        buffer += decoder.decode(chunk, { stream: true });

        // Support \r\n and \n line endings
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          throwIfAborted();
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;

          let parsed;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            if (this.debug)
              console.error(
                "[qwen sse parse error] raw:",
                jsonStr.slice(0, 200),
              );
            continue;
          }

          if (this.debug) {
            // Log all chunks when debugging — no limit
            console.error(
              `[qwen sse #${chunkCount}]`,
              JSON.stringify(parsed).slice(0, 500),
            );
            chunkCount++;
          }

          // Stream-level error codes
          if (parsed.code) {
            if (parsed.code === "RateLimited") {
              const err = new Error("Qwen: rate limit exceeded.");
              err.isRateLimit = true;
              throw err;
            }
            if (this.debug)
              console.error(
                "[qwen sse error code]",
                parsed.code,
                parsed.message ?? "",
              );
            continue;
          }

          const delta = parsed?.choices?.[0]?.delta;
          if (!delta) {
            if (this.debug)
              console.error(
                "[qwen] no delta, full event:",
                JSON.stringify(parsed).slice(0, 500),
              );
            continue;
          }

          // API sends thinking via delta.content + delta.phase === "think",
          // and the final answer via delta.content + delta.phase === "answer".
          // Older API versions may use delta.reasoning_content instead.
          const phase = delta.phase ?? "answer";
          const text =
            delta.content && delta.content !== "" ? delta.content : null;
          const reasoningText = delta.reasoning_content ?? null;

          if (reasoningText) {
            throwIfAborted();
            if (onThinking) await onThinking(reasoningText);
          } else if (text && phase === "think") {
            throwIfAborted();
            if (onThinking) await onThinking(text);
          } else if (text) {
            throwIfAborted();
            fullText += text;
            if (onText) await onText(text);
          }

          // Detect stream end signals
          if (
            delta.status === "finished" ||
            parsed?.choices?.[0]?.finish_reason
          ) {
            break;
          }
        }
      }

      if (this.debug)
        console.error("[qwen] stream ended, total length:", fullText.length);

      return fullText;
    } finally {
      if (signal) {
        signal.removeEventListener?.("abort", onAbort);
      }
    }
  }
}
