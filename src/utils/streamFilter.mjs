/**
 * Stream-filtering utilities for suppressing ```tool_call``` blocks in the
 * model's text output while streaming to the user.
 *
 * The model embeds tool calls as fenced code blocks inside its response text.
 * We must suppress these blocks (they are not meant to be shown to the user)
 * while passing regular text through immediately.
 *
 * Usage:
 *   const filter = createStreamFilter();
 *   // For each text chunk:
 *   const safeText = filter.feed(chunk);   // may be "" when inside a fence
 *   // After the stream ends:
 *   filter.reset();
 */

/**
 * Fence patterns that mark the start of a tool-call block in the stream.
 * The model sometimes uses the markdown fence (```tool_call) and sometimes
 * outputs just the label on its own line (tool_call\n{).
 *
 * @type {readonly string[]}
 */
export const TOOL_FENCES = Object.freeze([
  "```tool_call",
  "\ntool_call\n{",
  "tool_call\n{",
  // Bare JSON tool call that starts at the beginning of a new line.
  // Catches the case where the model outputs {"name": ... without a fence.
  '\n{"name":',
  '\n{"name" :',
]);

/**
 * Markers of leaked tool-result transcript blocks that should never be shown
 * to the user in assistant output.
 */
const TOOL_RESULT_STARTS = Object.freeze([
  "\nUser: [Tool result id=",
  "User: [Tool result id=",
]);

/** Marker indicating the assistant content resumes after leaked transcript. */
const ASSISTANT_RESUME_MARKERS = Object.freeze(["\nAssistant:", "Assistant:"]);

/** All stream markers that can start a suppressed block. */
const SUPPRESS_START_MARKERS = Object.freeze([
  ...TOOL_FENCES,
  ...TOOL_RESULT_STARTS,
]);

/**
 * Returns the index of the earliest tool-call fence found in `str`, or -1.
 *
 * @param {string} str
 * @returns {number}
 */
export function findFence(str) {
  let best = -1;
  for (const fence of TOOL_FENCES) {
    const idx = str.indexOf(fence);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

/**
 * Returns how many characters at the END of `str` could be a partial prefix
 * of any tool-call fence.  These characters must be held back in the buffer
 * until the next chunk arrives to confirm whether a fence starts here.
 *
 * @param {string} str
 * @returns {number}
 */
export function partialHoldBack(str) {
  let max = 0;
  for (const fence of SUPPRESS_START_MARKERS) {
    for (let len = Math.min(fence.length - 1, str.length); len >= 1; len--) {
      if (fence.startsWith(str.slice(-len))) {
        if (len > max) max = len;
        break;
      }
    }
  }
  return max;
}

/**
 * Stateful stream filter that buffers incoming text chunks and returns only
 * the parts that should be shown to the user (i.e., everything outside
 * ```tool_call``` fences).
 *
 * @returns {{ feed(chunk: string): string, reset(): void, inToolCall: boolean }}
 */
export function createStreamFilter() {
  let buf = "";
  let inToolCall = false;
  let inToolResult = false;
  let closeBuf = ""; // buffers tail while scanning for closing ```
  let resultBuf = ""; // buffers leaked transcript while scanning for Assistant:

  const findToolResultStart = (str) => {
    let best = -1;
    for (const marker of TOOL_RESULT_STARTS) {
      const idx = str.indexOf(marker);
      if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  };

  const processNormal = (chunk) => {
    buf += chunk;
    let safe = "";

    while (buf.length > 0) {
      const toolIdx = findFence(buf);
      const resultIdx = findToolResultStart(buf);

      let startIdx = -1;
      let startKind = "";
      if (toolIdx !== -1 && (resultIdx === -1 || toolIdx < resultIdx)) {
        startIdx = toolIdx;
        startKind = "tool";
      } else if (resultIdx !== -1) {
        startIdx = resultIdx;
        startKind = "result";
      }

      if (startIdx !== -1) {
        safe += buf.slice(0, startIdx);
        buf = "";
        if (startKind === "tool") {
          inToolCall = true;
          closeBuf = "";
        } else {
          inToolResult = true;
          resultBuf = "";
        }
        break;
      }
      const holdBack = partialHoldBack(buf);
      safe += buf.slice(0, buf.length - holdBack);
      buf = buf.slice(buf.length - holdBack);
      break;
    }

    return safe;
  };

  return {
    /** Feed a new text chunk; returns the text safe to emit (may be ""). */
    feed(chunk) {
      if (inToolResult) {
        // Discard leaked transcript until assistant content resumes
        resultBuf += chunk;

        let resumeIdx = -1;
        let markerLen = 0;
        for (const marker of ASSISTANT_RESUME_MARKERS) {
          const idx = resultBuf.indexOf(marker);
          if (idx !== -1 && (resumeIdx === -1 || idx < resumeIdx)) {
            resumeIdx = idx;
            markerLen = marker.length;
          }
        }

        if (resumeIdx === -1) {
          // Keep a short tail to detect split resume marker across chunks
          const maxMarkerLen = Math.max(
            ...ASSISTANT_RESUME_MARKERS.map((m) => m.length),
          );
          const hold = Math.min(maxMarkerLen - 1, resultBuf.length);
          resultBuf = resultBuf.slice(-hold);
          return "";
        }

        let rest = resultBuf.slice(resumeIdx + markerLen);
        if (rest.startsWith(" ")) rest = rest.slice(1);
        resultBuf = "";
        inToolResult = false;
        buf = "";
        return rest ? processNormal(rest) : "";
      }

      if (inToolCall) {
        // Scan for closing ``` fence
        closeBuf += chunk;
        const closeIdx = closeBuf.indexOf("```");
        if (closeIdx === -1) {
          // Hold back last 2 chars — could be partial ``
          const hold = Math.min(2, closeBuf.length);
          closeBuf = closeBuf.slice(-hold);
          return "";
        }
        // Found closing fence — discard everything up to and including it
        let rest = closeBuf.slice(closeIdx + 3);
        // Skip optional newline right after the fence
        if (rest.startsWith("\n")) rest = rest.slice(1);
        closeBuf = "";
        inToolCall = false;
        buf = "";
        // Process any text that follows the closing fence
        return rest ? processNormal(rest) : "";
      }

      return processNormal(chunk);
    },

    /** Resets all state (call when starting a new request). */
    reset() {
      buf = "";
      closeBuf = "";
      resultBuf = "";
      inToolCall = false;
      inToolResult = false;
    },

    /** True when the filter is currently inside a suppressed tool_call block. */
    get inToolCall() {
      return inToolCall;
    },
  };
}
