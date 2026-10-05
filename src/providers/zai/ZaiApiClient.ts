import { createLogger } from "../../logger";
import { buildFlatTranscript } from "../common/messages";
import { thinkingEnabled } from "../common/models";
import { sseEvents } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import { buildToolsSystemPrompt } from "../common/ToolCalling";
import type { AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import type { ZaiBrowserBridge } from "./ZaiBrowserBridge";
import {
  ZAI_MODELS,
  resolveZaiModelId,
  upstreamZaiModelId,
} from "./ZaiModels";

const PROVIDER_ID = "ai-free-vscode-zai";
/**
 * Conservative share of the input window. The conversation is flattened into
 * one message, so the oldest turns give way rather than the upstream refusing
 * the request outright.
 */
const MAX_PROMPT_TOKENS = 90000;

const log = createLogger("zai-api");

/** `data: {"type":"chat:completion","data":{…}}` — one SSE record. */
interface ZaiEvent {
  type?: string;
  data?: {
    phase?: string;
    delta_content?: string;
    /** Rewrites the message from `edit_index` on (see AnswerMirror). */
    edit_content?: string;
    edit_index?: number;
    /** Replaces the whole message. */
    content?: string;
    done?: boolean;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: ZaiError;
    /** Errors also arrive one level deeper. */
    data?: { error?: ZaiError };
  };
}

interface ZaiError {
  code?: string | number;
  error_code?: string;
  detail?: string;
  message?: string;
}

export class ZaiApiClient {
  constructor(private readonly bridge: ZaiBrowserBridge) {}

  async *sendMessageStream(
    params: AIRequestParams,
  ): AsyncIterable<AIStreamChunk> {
    const modelId = resolveZaiModelId(params.model);
    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;
    const thinking = thinkingEnabled(
      ZAI_MODELS,
      modelId,
      hasTools,
      params.thinkingMode,
    );

    const prompt = buildFlatTranscript(
      params.messages,
      hasTools ? buildToolsSystemPrompt(params.tools ?? []) : "",
      { maxTokens: MAX_PROMPT_TOKENS },
    );

    log.info(
      `request model=${modelId} thinking=${thinking} hasTools=${hasTools} promptChars=${prompt.length}`,
    );

    const router = new StreamingToolCallRouter(allowToolCalls, (m) =>
      log.debug(m),
    );
    const mirror = new AnswerMirror();
    let textChars = 0;
    let thinkingChars = 0;

    const raw = this.bridge.streamChat({
      model: upstreamZaiModelId(modelId),
      thinking,
      prompt,
      abortSignal: params.abortSignal,
    });

    for await (const record of sseEvents(raw)) {
      if (record.data === "[DONE]") break;

      let event: ZaiEvent;
      try {
        event = JSON.parse(record.data) as ZaiEvent;
      } catch {
        log.debug(`unparsed record: ${record.data.slice(0, 120)}`);
        continue;
      }
      const data = event.data;
      if (!data) continue;

      const error = data.error ?? data.data?.error;
      if (error) throw toError(error);

      if (data.edit_content !== undefined || data.content !== undefined) {
        log.debug(
          `rewrite record phase=${data.phase} edit_index=${data.edit_index ?? "-"} ${JSON.stringify(
            (data.edit_content ?? data.content ?? "").slice(0, 160),
          )}`,
        );
      }

      const { thinking: thought, answer } = mirror.apply(data);
      if (thought) {
        const clean = stripReasoningMarkup(thought);
        if (clean) {
          thinkingChars += clean.length;
          yield { type: "thinking", content: clean };
        }
      }
      if (answer) {
        textChars += answer.length;
        yield* router.route(answer);
      }

      if (data.usage) {
        yield {
          type: "usage",
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
        };
      }
      if (data.phase === "done" || data.done || router.cut) break;
    }

    yield* router.finish();

    log.info(
      `stream done textChars=${textChars} thinkingChars=${thinkingChars}`,
    );
    if (textChars === 0 && thinkingChars === 0) {
      log.warn("stream finished without content");
    }
  }
}

/**
 * Rebuilds the answer the way chat.z.ai itself does, and hands out what is new.
 *
 * The web app keeps one string per message and updates it three ways:
 * `delta_content` appends, `edit_content` rewrites everything from
 * `edit_index` on, `content` replaces the lot. Edits show up where the
 * reasoning hands over to the answer — the start of the answer then arrives
 * inside the edit, and reading deltas alone loses it (the reply began
 * mid-word). Mirroring that string keeps us on exactly what the site shows.
 *
 * The string holds the reasoning first, then the answer. The answer starts
 * where the first `answer` record found the string, or after the reasoning's
 * `</details>` block when an edit reaches back into it.
 */
export class AnswerMirror {
  private content = "";
  private answerFrom = -1;
  private emitted = 0;

  apply(data: {
    phase?: string;
    delta_content?: string;
    edit_content?: string;
    edit_index?: number;
    content?: string;
  }): { thinking?: string; answer?: string } {
    const isAnswer = data.phase === "answer";
    if (isAnswer && this.answerFrom < 0) this.answerFrom = this.content.length;

    let rewroteFrom: number | undefined;
    if (data.edit_content !== undefined) {
      const at = clamp(data.edit_index ?? 0, 0, this.content.length);
      this.content = this.content.slice(0, at) + data.edit_content;
      rewroteFrom = at;
    } else if (data.content !== undefined) {
      this.content = data.content;
      rewroteFrom = 0;
    } else if (data.delta_content) {
      this.content += data.delta_content;
      // Reasoning goes out as it comes; only the answer needs the mirror.
      if (!isAnswer && this.answerFrom < 0) {
        return { thinking: data.delta_content };
      }
    } else {
      return {};
    }

    if (this.answerFrom < 0) return {};

    if (rewroteFrom !== undefined && rewroteFrom < this.answerFrom) {
      const close = this.content.lastIndexOf("</details>");
      this.answerFrom =
        close >= 0 ? close + "</details>".length : Math.min(rewroteFrom, this.content.length);
    }

    let answer = this.content.slice(this.answerFrom);
    // The very start may carry the blank lines that followed the reasoning.
    if (this.emitted === 0) {
      const trimmed = answer.replace(/^\s+/, "");
      this.answerFrom += answer.length - trimmed.length;
      answer = trimmed;
    }

    // Text already sent cannot be taken back; a rewrite of it only moves the
    // mark, and what comes after is sent as usual.
    const fresh = answer.length > this.emitted ? answer.slice(this.emitted) : "";
    this.emitted = Math.max(this.emitted, answer.length);
    return fresh ? { answer: fresh } : {};
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Older GLM builds wrap the reasoning in a `<details>` block of their own. */
function stripReasoningMarkup(text: string): string {
  return text
    .replace(/<details[^>]*>|<\/details>/g, "")
    .replace(/<summary>[\s\S]*?<\/summary>/g, "");
}

function toError(error: ZaiError): Error {
  const code = String(error.error_code ?? error.code ?? "");
  const detail = error.detail ?? error.message ?? code;

  if (code === "401" || /^unauthori[sz]ed$/i.test(detail)) {
    return new AuthExpiredError(PROVIDER_ID);
  }
  if (code === "429" || /rate limit|too many/i.test(detail)) {
    return new RateLimitError(PROVIDER_ID);
  }
  if (/CAPTCHA/i.test(code)) {
    return new ProviderError(
      PROVIDER_ID,
      "Z.ai rejected the verification. Send the request again; if it keeps failing, open chat.z.ai in the browser once.",
    );
  }
  return new ProviderError(PROVIDER_ID, `Z.ai error: ${detail}`);
}
