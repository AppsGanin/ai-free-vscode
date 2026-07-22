import type { AIStreamChunk } from "../types";
import {
  findToolCallMarkerStart,
  looksLikeToolCallStart,
  parseToolCallsFromText,
  stripToolCallBlocks,
} from "./ToolCalling";

// Held text that stops looking like a tool call is released as plain text
// (false marker hit on markdown/code).
const MAX_HOLD_CHARS = 4096;
// Hard cap for confirmed calls with huge arguments (a whole file).
const MAX_HOLD_HARD_CAP_CHARS = 262144;
// Tail kept back to catch a marker split across chunks (len("```tool_call") - 1).
const MARKER_HOLDBACK_CHARS = 11;

// Small models "play out" the joined transcript after their answer, echoing the
// role prefixes, our tool-result placeholder, or a whole tool result with its
// call id. Anchoring to line starts and to very specific markers keeps false
// cuts unlikely. Shared by all providers — Qwen/DeepSeek/Kimi/MiMo all join the
// dialog the same way.
const TRANSCRIPT_CUT_PATTERN = new RegExp(
  [
    // `\nUser:` / `\nAssistant:` at the start of a line
    "(?:\\n|^)[ \\t]*(?:user|assistant)[ \\t]*:",
    // our own placeholder
    "\\[tool result id=",
    // a call id echoed anywhere, e.g. `Environment: [toolu_bdrk_018gnVobT…]`
    "\\[(?:toolu|call|tooluse)_[\\w-]{6,}",
  ].join("|"),
  "i",
);
// Longest marker prefix worth holding back: len("[Tool result id=") - 1.
const TRANSCRIPT_CUT_HOLDBACK_CHARS = 15;
// A cut drops the whole line its marker sits on, so the current partial line is
// held back too — otherwise a label like `Environment: ` is already in the chat
// by the time the marker arrives. Bounded, so a long paragraph still streams.
const TRANSCRIPT_CUT_LINE_HOLDBACK_CHARS = 200;

/**
 * Unpaired closing tags. The model drops them into the stream away from the
 * call itself, so no opening marker holds them back and they leak into the chat.
 */
const STRAY_CLOSE_TAGS = [
  "</tool_call>",
  "</function>",
  "</parameter>",
  "</tool_name>",
  "</tool_arguments>",
];
const STRAY_CLOSE_TAG_RE =
  /<\/(?:tool_call|function|parameter|tool_name|tool_arguments)>[ \t]*\n?/gi;

/** Length of a tail that looks like the start of a closing tag (`<`, `</too`…). */
function trailingCloseTagPrefixLen(text: string): number {
  let longest = 0;
  for (const tag of STRAY_CLOSE_TAGS) {
    for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
      if (text.endsWith(tag.slice(0, len))) {
        longest = Math.max(longest, len);
        break;
      }
    }
  }
  return longest;
}

export function stripDanglingToolCallMarkers(text: string): string {
  return (
    text
      .replace(/```tool_call\s*```?/gi, "")
      .replace(/```tool_call\s*$/gim, "")
      .replace(/^\s*```tool_call\s*\n?/gim, "")
      .replace(/^\s*<tool_call\b[^>]*>\s*$/gim, "")
      // Orphaned MiMo/Qwen-Coder XML tags: the model regularly loses one side.
      .replace(/<tool_call\b[^>]*>|<\/tool_call>/gi, "")
      .replace(/<function\s*=\s*[\w.:-]+\s*>|<\/function>/gi, "")
      .replace(/<parameter\s*=\s*[\w.:-]+\s*>|<\/parameter>/gi, "")
      .replace(/<\/?tool_name>|<\/?tool_arguments>/gi, "")
      .trim()
  );
}

/**
 * Cleans the held region once a call was (or was not) extracted from it.
 * Runs on the raw buffer, before the tags are stripped: whole blocks can only
 * be matched while their opening tag is still there.
 */
function sanitizeHoldRemainder(text: string): string {
  if (!text) return "";
  return (
    stripToolCallBlocks(text)
      // `<tool_call name="x">{…}` — the arguments carry no `name` of their own,
      // so nothing else would recognise them as protocol. Closing tag optional.
      .replace(/<tool_call\b[^>]*>[\s\S]*?(?:<\/tool_call>|$)/gi, "\n\n")
      .replace(/<function\s*=\s*[\w.:-]+\s*>[\s\S]*?<\/function>/gi, "\n\n")
      .replace(
        /<tool_name>[\s\S]*?<\/tool_name>(\s*<tool_arguments>[\s\S]*?<\/tool_arguments>)?/gi,
        "\n\n",
      )
      .replace(/^\s*Assistant:\s?/gim, "")
      .replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n")
      // Orphaned fences left behind by the removals above; safe here because
      // this only ever runs on a hold region, never on normal prose.
      .replace(/```[a-zA-Z0-9_-]*/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
  );
}

/**
 * Routes a text stream into text / tool_call chunks.
 *
 * Web models (DeepSeek/Qwen/Kimi/MiMo) have no native tool_calls — they print
 * the call into the answer (```tool_call … ```). This class spots the marker
 * with a sliding window, holds the candidate until the stream ends and then
 * parses it, so the raw protocol never reaches the chat.
 *
 *   for (...) yield* router.route(textChunk);
 *   yield* router.finish();
 */
export class StreamingToolCallRouter {
  private pendingBuffer = "";
  private closeTagTail = "";
  private holdBuffer = "";
  private holdActive = false;
  private cutActive = false;
  private cutBuffer = "";

  constructor(
    private readonly allowToolCalls: boolean,
    private readonly logger?: (msg: string) => void,
    private readonly logPrefix = "",
  ) {}

  /**
   * True while a potential tool call is held (marker seen, call not finished).
   * Callers use it to avoid cutting the stream mid-call.
   */
  get holding(): boolean {
    return this.holdActive;
  }

  /**
   * True once a fabricated next turn was detected and the rest is dropped. The
   * caller should stop the upstream so the model stops burning tokens.
   */
  get cut(): boolean {
    return this.cutActive;
  }

  /**
   * Transcript guard: emits text up to the fabricated turn and discards the
   * rest. The holdback keeps a tail so a split boundary is not missed.
   */
  *route(rawText: string): Iterable<AIStreamChunk> {
    if (!rawText || this.cutActive) {
      return;
    }

    this.cutBuffer += rawText;
    const match = TRANSCRIPT_CUT_PATTERN.exec(this.cutBuffer);
    if (match) {
      this.cutActive = true;
      // Drop the whole line the marker sits on: a label in front of it
      // (`Environment: [toolu_…]`) belongs to the echo, not to the answer.
      const lineStart = this.cutBuffer.lastIndexOf("\n", match.index) + 1;
      const safe = this.cutBuffer.slice(0, lineStart).replace(/\s+$/, "");
      this.cutBuffer = "";
      if (safe) yield* this.routeSafe(safe);
      return;
    }

    const lineStart = this.cutBuffer.lastIndexOf("\n") + 1;
    const holdback = Math.max(
      TRANSCRIPT_CUT_HOLDBACK_CHARS,
      Math.min(
        this.cutBuffer.length - lineStart,
        TRANSCRIPT_CUT_LINE_HOLDBACK_CHARS,
      ),
    );

    const emitUpTo = this.cutBuffer.length - holdback;
    if (emitUpTo <= 0) {
      return;
    }
    const safe = this.cutBuffer.slice(0, emitUpTo);
    this.cutBuffer = this.cutBuffer.slice(emitUpTo);
    yield* this.routeSafe(safe);
  }

  /** Flushes the buffers: parses a tool call, or emits the tail as text. */
  *finish(): Iterable<AIStreamChunk> {
    yield* this.flushCutTail();
    const { holdBuffer, tailText } = this.takeBuffers();

    if (holdBuffer) {
      const toolChunks = Array.from(
        parseToolCallsFromText(holdBuffer, {
          logger: this.logger,
          logPrefix: this.logPrefix,
        }),
      ).filter((c) => c.type === "tool_call");
      const remainder = stripDanglingToolCallMarkers(
        sanitizeHoldRemainder(holdBuffer),
      );

      if (toolChunks.length > 0) {
        yield* toolChunks;
        if (remainder.trim()) yield* this.emitText(remainder);
      } else {
        yield* this.emitText(remainder || holdBuffer.trim());
      }
    }

    if (tailText) yield* this.emitText(tailText);
    yield* this.flushCloseTagTail();
  }

  /**
   * Flushes everything as text without parsing. Used when the calls already
   * arrived through another channel (native tool_calls) and the held text must
   * not turn into a duplicate.
   */
  *finishAsText(): Iterable<AIStreamChunk> {
    yield* this.flushCutTail();
    const { holdBuffer, tailText } = this.takeBuffers();

    if (holdBuffer) {
      yield* this.emitText(
        stripDanglingToolCallMarkers(sanitizeHoldRemainder(holdBuffer)),
      );
    }
    if (tailText) yield* this.emitText(tailText);
    yield* this.flushCloseTagTail();
  }

  private takeBuffers(): { holdBuffer: string; tailText: string } {
    const holdBuffer = this.holdActive ? this.holdBuffer : "";
    const tailText = this.holdActive ? "" : this.pendingBuffer;
    this.pendingBuffer = "";
    this.holdBuffer = "";
    this.holdActive = false;
    return { holdBuffer, tailText };
  }

  private *routeSafe(rawText: string): Iterable<AIStreamChunk> {
    if (!this.allowToolCalls) {
      yield* this.emitText(rawText);
      return;
    }

    if (this.holdActive) {
      this.holdBuffer += rawText;
      const overSoftLimit = this.holdBuffer.length >= MAX_HOLD_CHARS;
      const overHardCap = this.holdBuffer.length >= MAX_HOLD_HARD_CAP_CHARS;
      if (
        (overSoftLimit && !looksLikeToolCallStart(this.holdBuffer)) ||
        overHardCap
      ) {
        yield* this.emitText(stripDanglingToolCallMarkers(this.holdBuffer));
        this.holdBuffer = "";
        this.holdActive = false;
      }
      return;
    }

    this.pendingBuffer += rawText;
    const markerIdx = findToolCallMarkerStart(this.pendingBuffer);

    if (markerIdx !== -1) {
      yield* this.emitText(this.pendingBuffer.slice(0, markerIdx));
      this.holdBuffer = this.pendingBuffer.slice(markerIdx);
      this.pendingBuffer = "";
      this.holdActive = true;
      return;
    }

    const emitUpTo = this.pendingBuffer.length - MARKER_HOLDBACK_CHARS;
    if (emitUpTo > 0) {
      yield* this.emitText(this.pendingBuffer.slice(0, emitUpTo));
      this.pendingBuffer = this.pendingBuffer.slice(emitUpTo);
    }
  }

  /** Single exit for text: strips orphaned closing tags of the protocol. */
  private *emitText(text: string): Iterable<AIStreamChunk> {
    let content = (this.closeTagTail + text).replace(STRAY_CLOSE_TAG_RE, "");
    this.closeTagTail = "";

    // A tag split across chunks must not be emitted in halves — the chat would
    // glue them back into a visible `</tool_call>`.
    const partial = trailingCloseTagPrefixLen(content);
    if (partial > 0) {
      this.closeTagTail = content.slice(content.length - partial);
      content = content.slice(0, content.length - partial);
    }

    if (content) yield { type: "text", content };
  }

  private *flushCloseTagTail(): Iterable<AIStreamChunk> {
    const tail = this.closeTagTail;
    this.closeTagTail = "";
    if (tail) yield { type: "text", content: tail };
  }

  /** Releases the guard holdback when no boundary ever showed up. */
  private *flushCutTail(): Iterable<AIStreamChunk> {
    if (this.cutBuffer && !this.cutActive) {
      const tail = this.cutBuffer;
      this.cutBuffer = "";
      yield* this.routeSafe(tail);
    }
  }
}
