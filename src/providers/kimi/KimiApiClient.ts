import { createLogger } from "../../logger";
import { isAbortError, throwForStatus } from "../common/http";
import { buildFlatTranscript } from "../common/messages";
import { thinkingEnabled } from "../common/models";
import { readChunks } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import { buildToolsSystemPrompt } from "../common/ToolCalling";
import type { AIRequestParams, AIStreamChunk } from "../types";
import { ProviderError } from "../types";
import { KIMI_MODELS, resolveKimiModelId } from "./KimiModels";

const PROVIDER_ID = "ai-free-vscode-kimi";
const BASE_URL = "https://www.kimi.com";
const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const SCENARIO = "SCENARIO_K2D5";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STREAM_TIMEOUT_MS = 120000;
/**
 * Conservative share of the model's 131k input window. The whole conversation
 * is flattened into one turn, so agent loops carrying whole files in their tool
 * results run past it; the oldest turns are dropped rather than letting the
 * upstream refuse the request outright.
 */
const MAX_PROMPT_TOKENS = 75000;
/** Connect protocol frame header: 1 flag byte + 4 length bytes. */
const FRAME_HEADER_BYTES = 5;

const log = createLogger("kimi-api");

export interface KimiAuthState {
  token: string;
}

interface KimiFrame {
  error?: { message?: string; code?: string } | string;
  heartbeat?: unknown;
  op?: string;
  done?: unknown;
  block?: {
    type?: string;
    text?: { content?: string };
    thinking?: { content?: string };
    tool?: unknown;
  };
  chat?: { id?: string };
  message?: { id?: string; role?: string };
}

export class KimiApiClient {
  async *sendMessageStream(
    params: AIRequestParams,
    auth: KimiAuthState,
  ): AsyncIterable<AIStreamChunk> {
    const modelId = resolveKimiModelId(params.model);
    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;
    const thinking = thinkingEnabled(
      KIMI_MODELS,
      modelId,
      hasTools,
      params.thinkingMode,
    );

    const content = buildFlatTranscript(
      params.messages,
      hasTools ? buildToolsSystemPrompt(params.tools ?? []) : "",
      { maxTokens: MAX_PROMPT_TOKENS },
    );

    log.info(
      `request model=${modelId} thinking=${thinking} hasTools=${hasTools} contentChars=${content.length}`,
    );

    const response = await fetch(`${BASE_URL}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "User-Agent": USER_AGENT,
        "X-Msh-Platform": "web",
      },
      body: encodeFrame(
        JSON.stringify({
          scenario: SCENARIO,
          chat_id: "",
          tools: [],
          message: {
            parent_id: "",
            role: "user",
            blocks: [{ message_id: "", text: { content } }],
            scenario: SCENARIO,
          },
          options: { thinking },
        }),
      ),
      signal: params.abortSignal,
    });

    log.debug(`response status=${response.status}`);
    throwForStatus(PROVIDER_ID, response);

    if (!response.ok || !response.body) {
      const txt = await response.text().catch(() => "");
      log.error(`request failed HTTP ${response.status}: ${txt.slice(0, 220)}`);
      throw new ProviderError(
        PROVIDER_ID,
        `HTTP ${response.status}: ${txt.slice(0, 220)}`,
        response.status,
      );
    }

    yield* this.parseFrames(response.body, allowToolCalls, params.abortSignal);
  }

  private async *parseFrames(
    body: ReadableStream<Uint8Array>,
    allowToolCalls: boolean,
    abortSignal?: AbortSignal,
  ): AsyncIterable<AIStreamChunk> {
    const router = new StreamingToolCallRouter(allowToolCalls, (m) =>
      log.debug(m),
    );
    let buffer = Buffer.alloc(0);
    let textChars = 0;
    let thinkingChars = 0;
    let nativeToolCalls = 0;
    let done = false;

    const handleFrame = function* (frame: KimiFrame): Iterable<AIStreamChunk> {
      if (frame.error) {
        const text =
          typeof frame.error === "string"
            ? frame.error
            : (frame.error.message ?? frame.error.code ?? "Kimi API error");
        throw new ProviderError(PROVIDER_ID, `Kimi error: ${text}`);
      }
      if (frame.heartbeat) return;

      // Kimi's own code-interpreter runs server-side and keeps generating, so we
      // just wait for the resulting text and only count the calls.
      if (frame.block?.tool) {
        if (frame.op === "set") nativeToolCalls++;
        return;
      }
      if (frame.op !== "append" && frame.op !== "set") {
        done = frame.done !== undefined;
        return;
      }

      const thinking = frame.block?.thinking?.content;
      if (thinking) {
        thinkingChars += thinking.length;
        yield { type: "thinking", content: thinking };
      }

      const text = frame.block?.text?.content;
      if (text) {
        if (/think|reason/i.test(frame.block?.type ?? "")) {
          thinkingChars += text.length;
          yield { type: "thinking", content: text };
        } else {
          textChars += text.length;
          yield* router.route(text);
        }
      }

      if (frame.done !== undefined) done = true;
    };

    try {
      for await (const chunk of readChunks(body, {
        providerId: PROVIDER_ID,
        idleTimeoutMs: STREAM_TIMEOUT_MS,
      })) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        let offset = 0;
        while (offset + FRAME_HEADER_BYTES <= buffer.length) {
          const length = buffer.readUInt32BE(offset + 1);
          const end = offset + FRAME_HEADER_BYTES + length;
          if (end > buffer.length) break;

          const payload = buffer
            .subarray(offset + FRAME_HEADER_BYTES, end)
            .toString("utf8")
            .trim();
          offset = end;

          if (payload) {
            try {
              yield* handleFrame(JSON.parse(payload) as KimiFrame);
            } catch (err) {
              if (err instanceof ProviderError) throw err;
              log.debug(`frame parse failed: ${payload.slice(0, 120)}`);
            }
          }
          if (router.cut) {
            log.debug("transcript boundary detected — stopping stream");
            done = true;
          }
          if (done) break;
        }

        buffer = buffer.subarray(offset);
        if (done) break;
      }
    } catch (err) {
      if (!isAbortError(err, abortSignal)) {
        throw err;
      }
      log.debug("stream aborted by caller");
    }

    yield* router.finish();

    log.info(
      `stream done textChars=${textChars} thinkingChars=${thinkingChars} nativeToolCalls=${nativeToolCalls}`,
    );
    if (textChars === 0 && thinkingChars === 0) {
      log.warn("stream finished without content");
    }
  }
}

/** Connect protocol frame: flag byte + big-endian length + JSON payload. */
function encodeFrame(json: string): ArrayBuffer {
  const bytes = Buffer.from(json, "utf8");
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + bytes.length);
  const view = new DataView(buffer);
  view.setUint8(0, 0);
  view.setUint32(1, bytes.length, false);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(bytes);
  return buffer;
}
