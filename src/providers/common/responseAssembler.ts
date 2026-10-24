import { type ScopedLogger, errDetails, errToString, isDebugEnabled } from "../../logger";
import type { AIStreamChunk, AIToolDefinition } from "../types";
import {
  looksLikeToolCallStart,
  parseToolCallsFromText,
  stripToolCallBlocks,
  summarizeToolCalls,
} from "./ToolCalling";

/**
 * Turns a provider's raw chunk stream into what a chat host shows: text with
 * the prompt tool protocol scrubbed out, reasoning, and whole tool calls with
 * schema-typed arguments — including calls that leaked into the text or
 * reasoning channel instead of arriving structurally.
 *
 * Host-neutral: VS Code (VSCodeLMAdapter) and the DeepSeek Harness plugin
 * differ only in the sink.
 */
export interface ResponseSink {
  text(part: string): Promise<void>;
  thinking(part: string): Promise<void>;
  /** A complete call; `input` is already normalized against the tool schema. */
  toolCall(callId: string, name: string, input: Record<string, unknown>): Promise<void>;
  usage(promptTokens: number, completionTokens: number): Promise<void>;
  /**
   * Pushes out anything the sink buffers. Called before every tool call and
   * usage record, so the display order stays the order of the stream, and
   * before the response ends or fails.
   */
  flush(): Promise<void>;
}

export interface AssembleOptions {
  /** The tools travel as a prompt protocol whose markers must be scrubbed. */
  promptToolProtocol: boolean;
  tools?: readonly AIToolDefinition[];
  log: ScopedLogger;
  startedAt: number;
  /** Polled per chunk; true stops reading (the user cancelled). */
  isCancelled?: () => boolean;
}

export interface AssembledResponse {
  textChars: number;
  thinkingChars: number;
  toolCalls: AIStreamChunk[];
  /** The provider reported token usage itself. */
  gotProviderUsage: boolean;
}

export async function assembleResponse(
  stream: AsyncIterable<AIStreamChunk>,
  sink: ResponseSink,
  opts: AssembleOptions,
): Promise<AssembledResponse> {
  const { promptToolProtocol, tools, log, startedAt } = opts;

  // Tool call arguments arrive in pieces, keyed by call id.
  const pendingToolCalls = new Map<string, { name: string; args: string }>();
  const emitted: AIStreamChunk[] = [];
  let textChars = 0;
  let thinkingChars = 0;
  let gotProviderUsage = false;
  // Full raw streams, used to recover a tool call that leaked into the text or
  // reasoning channel instead of arriving structurally.
  let rawTextAll = "";
  let thinkingAll = "";
  let firstChunkAt = 0;
  const chunkCounts: Record<string, number> = {};

  const emitToolCall = async (callId: string, name: string, args: string) => {
    // Log what the host actually receives, not the raw text: normalization
    // repairs things like read_file's endLine=0.
    const input = normalizeToolArguments(name, tryParseJsonObject(args) ?? {}, tools);
    await sink.toolCall(callId, name, input);
    emitted.push({ type: "tool_call", callId, name, argumentsPart: args });
    log.debug(`tool_call #${emitted.length} ${name} ${JSON.stringify(input).slice(0, 300)}`);
  };

  try {
    for await (const chunk of stream) {
      chunkCounts[chunk.type] = (chunkCounts[chunk.type] ?? 0) + 1;
      if (!firstChunkAt) {
        firstChunkAt = Date.now();
        log.debug(`first ${chunk.type} chunk after ${firstChunkAt - startedAt}ms`);
      }
      if (opts.isCancelled?.()) {
        log.info(`chat cancelled after ${Date.now() - startedAt}ms`);
        break;
      }

      if (chunk.type === "text") {
        rawTextAll += chunk.content;
        const safe = sanitizeToolProtocol(chunk.content, promptToolProtocol);
        if (!safe) continue;
        textChars += safe.length;
        await sink.text(safe);
      } else if (chunk.type === "thinking") {
        thinkingChars += chunk.content.length;
        thinkingAll += chunk.content;
        await sink.thinking(chunk.content);
      } else if (chunk.type === "tool_call") {
        // Flush pending text so the display order stays correct.
        await sink.flush();

        const existing = pendingToolCalls.get(chunk.callId);
        const name = existing?.name ?? chunk.name;
        const args = (existing?.args ?? "") + chunk.argumentsPart;

        // Emit as soon as the arguments become valid JSON.
        if (tryParseJsonObject(args)) {
          await emitToolCall(chunk.callId, name, args);
          pendingToolCalls.delete(chunk.callId);
        } else {
          pendingToolCalls.set(chunk.callId, { name, args });
        }
      } else if (chunk.type === "usage") {
        await sink.flush();
        gotProviderUsage = true;
        log.debug(`provider usage prompt=${chunk.promptTokens} completion=${chunk.completionTokens}`);
        await sink.usage(chunk.promptTokens, chunk.completionTokens);
      }
    }
  } catch (err) {
    await sink.flush();
    log.error(
      `chat error after ${Date.now() - startedAt}ms (text=${textChars} thinking=${thinkingChars} toolCalls=${emitted.length}): ${errToString(err)}`,
    );
    log.debug(`error details: ${errDetails(err)}`);
    logRawOutput(log, rawTextAll, thinkingAll, chunkCounts);
    throw err;
  }

  await sink.flush();

  for (const [callId, call] of pendingToolCalls) {
    log.debug(`flushing tool_call with incomplete arguments: ${call.name}`);
    await emitToolCall(callId, call.name, call.args);
  }

  // Nothing structural arrived, but a call may have leaked into another
  // channel (oversized call past the provider holdback, or thinking+tools).
  if (promptToolProtocol && emitted.length === 0) {
    for (const [source, buffer] of [
      ["text", rawTextAll],
      ["thinking", thinkingAll],
    ] as const) {
      if (!looksLikeToolCallStart(buffer)) continue;
      for (const tc of parseToolCallsFromText(buffer)) {
        if (tc.type === "tool_call") {
          await emitToolCall(tc.callId, tc.name, tc.argumentsPart);
        }
      }
      if (emitted.length > 0) {
        log.info(`recovered ${emitted.length} tool_call(s) from the ${source} channel`);
        break;
      }
    }
  }

  log.info(
    `chat done in ${Date.now() - startedAt}ms text=${textChars} thinking=${thinkingChars} toolCalls=${emitted.length}${
      emitted.length > 0 ? ` [${summarizeToolCalls(emitted)}]` : ""
    }${gotProviderUsage ? "" : " usage=estimated"}`,
  );
  if (textChars === 0 && thinkingChars === 0 && emitted.length === 0) {
    log.warn(`empty answer — raw text was ${rawTextAll.length} chars, thinking ${thinkingAll.length}`);
  }
  // What the model actually wrote: most tool-calling bugs are a dialect or a
  // marker the parser did not expect, and only the raw text shows it.
  logRawOutput(log, rawTextAll, thinkingAll, chunkCounts);

  return { textChars, thinkingChars, toolCalls: emitted, gotProviderUsage };
}

function logRawOutput(
  log: ScopedLogger,
  rawText: string,
  thinking: string,
  chunkCounts: Record<string, number>,
): void {
  if (!isDebugEnabled()) return;
  const counts = Object.entries(chunkCounts)
    .map(([type, n]) => `${type}=${n}`)
    .join(" ");
  log.debug(
    `chunks: ${counts || "none"} · raw text ${rawText.length} chars · thinking ${thinking.length} chars`,
  );
  if (rawText) log.debug(`raw text: ${excerpt(rawText)}`);
  if (thinking) log.debug(`raw thinking: ${excerpt(thinking, 300)}`);
}

/** Head and tail of a long text on one line, so a log entry stays readable. */
export function excerpt(text: string, edge = 400): string {
  const flat = JSON.stringify(text).slice(1, -1); // newlines → \n
  if (flat.length <= edge * 2 + 20) return flat;
  return `${flat.slice(0, edge)} …[${flat.length - edge * 2} chars]… ${flat.slice(-edge)}`;
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const raw = (text ?? "").trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return undefined;
  }
}

/** read_file is the one tool models routinely call with a broken line range. */
function normalizeToolArguments(
  toolName: string,
  rawArgs: Record<string, unknown>,
  tools?: readonly AIToolDefinition[],
): Record<string, unknown> {
  const args = retypeAgainstSchema(toolName, rawArgs, tools);
  if (toolName !== "read_file") return args;

  const toNumber = (value: unknown): number | undefined => {
    const parsed = typeof value === "string" ? Number(value) : value;
    return typeof parsed === "number" && Number.isFinite(parsed)
      ? parsed
      : undefined;
  };

  const startLine = Math.max(1, Math.floor(toNumber(args.startLine) ?? 1));
  const rawEnd = toNumber(args.endLine);
  const endLine =
    rawEnd !== undefined && Math.floor(rawEnd) >= startLine
      ? Math.floor(rawEnd)
      : startLine + 1999;

  return { ...args, startLine, endLine };
}

/**
 * Re-types arguments against the schema the tool declared.
 *
 * The XML call dialects carry no types — `<parameter name="query">2024</…>` is
 * just text — so the parser has to guess, and it turns a path named `123` or a
 * query of `true` into a number or a boolean. VS Code validates the input
 * against the tool schema and drops the call. Only conversions the schema
 * actually asks for are applied; a parameter the tool did not declare is left
 * exactly as it arrived.
 */
function retypeAgainstSchema(
  toolName: string,
  args: Record<string, unknown>,
  tools?: readonly AIToolDefinition[],
): Record<string, unknown> {
  const properties = (
    tools?.find((t) => t.name === toolName)?.parameters as
      | { properties?: Record<string, unknown> }
      | undefined
  )?.properties;
  if (!properties) return args;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = coerceToSchemaType(
      value,
      declaredType(properties[key]),
      declaredType((properties[key] as { items?: unknown } | undefined)?.items),
    );
  }
  return result;
}

/** First concrete type of a property, through `type: ["string","null"]` unions. */
function declaredType(property: unknown): string | undefined {
  const type = (property as { type?: unknown } | undefined)?.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) {
    return type.find((t): t is string => typeof t === "string" && t !== "null");
  }
  return undefined;
}

function coerceToSchemaType(
  value: unknown,
  type: string | undefined,
  itemsType?: string,
): unknown {
  if (type === undefined || value === null || value === undefined) return value;

  if (type === "string") {
    // Only the parser's own guesses are undone. An object stringified here
    // would hide a real mismatch behind "[object Object]".
    return typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value;
  }

  if (typeof value !== "string") return value;

  if (type === "number" || type === "integer") {
    const parsed = Number(value.trim());
    if (value.trim() === "" || !Number.isFinite(parsed)) return value;
    return type === "integer" ? Math.trunc(parsed) : parsed;
  }

  if (type === "boolean") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    return value;
  }

  if (type === "array" && !/^\s*\[/.test(value)) {
    return arrayFromText(value, itemsType) ?? value;
  }

  if (type === "array" || type === "object") {
    if (!/^\s*[[{]/.test(value)) return value;
    try {
      const parsed: unknown = JSON.parse(value);
      const matches =
        type === "array"
          ? Array.isArray(parsed)
          : typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed);
      return matches ? parsed : value;
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * An array written as text, the way models write ranges: "1-180", "1:120",
 * "10:-1", "1..80" → [1, 180]. A single value where a list of strings is due
 * becomes a one-item list. Anything less clear-cut is left for the tool to
 * reject — guessing at other shapes would hand it wrong values instead.
 */
function arrayFromText(
  value: string,
  itemsType: string | undefined,
): unknown[] | undefined {
  const text = value.trim();

  // Untyped items: only the unmistakable numeric range is taken.
  if (itemsType === "integer" || itemsType === "number" || itemsType === undefined) {
    // The separator comes first in the alternation so "1-180" is a range,
    // while "10:-1" still keeps its negative end (-1 = to the end of file).
    const range = /^(-?\d+(?:\.\d+)?)\s*(?:-|–|:|,|\.\.|\s+to\s+|\s+)\s*(-?\d+(?:\.\d+)?)$/i.exec(text);
    if (range) return [Number(range[1]), Number(range[2])];
    if (itemsType && /^-?\d+(?:\.\d+)?$/.test(text)) return [Number(text)];
    return undefined;
  }

  if (itemsType === "string" && text) return [text];
  return undefined;
}

/**
 * Strips raw tool protocol and echoed transcript out of a streamed text chunk.
 *
 * NOTE: horizontal whitespace is never collapsed here — this runs on every
 * partial chunk, and `/[ \t]{2,}/ → " "` ate code indentation.
 */
function sanitizeToolProtocol(text: string, enabled: boolean): string {
  if (!enabled || !text) return text;

  return (
    stripToolCallBlocks(text)
      .replace(/^\s*tool_call\s*$/gim, "\n")
      .replace(
        /^\s*(?:User:\s*)?\[(?:Tool result id=[^\]]+|toolu_[^\]]+)\][\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|$(?![\s\S]))/gim,
        "\n",
      )
      .replace(
        /^\s*\{\s*"status"\s*:\s*"success"[\s\S]*?"type"\s*:\s*"[^"]*_result"[\s\S]*?(?=^\s*(Assistant:|User:|Tool:)|$(?![\s\S]))/gim,
        "\n",
      )
      .replace(/^\s*Tool:\s.*$/gim, "\n")
      .replace(/^\s*User:\s*Tool result:.*$/gim, "\n")
      .replace(/^\s*User:\s*\[call_[^\]]+\].*$/gim, "\n")
      .replace(/^\s*\/Users\/[^\n]*chat-session-resources[^\n]*$/gim, "\n")
      .replace(/^\s*Assistant:\s?/gim, "")
      // Only fully empty fenced blocks; real code fences stay untouched.
      .replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
  );
}
