import type { AIStreamChunk, AIToolDefinition } from "../types";

export interface ToolCallParseOptions {
  logger?: (message: string) => void;
  logPrefix?: string;
}

const TOOL_CALL_MARKERS = [
  "```tool_call",
  // Bare `<tool_call>` and the attribute form `<tool_call name="…">`.
  "<tool_call",
  "`tool_call {",
  "tool_call {",
  "\ntool_call {",
  // MiMo/Qwen-Coder native XML: <function=name><parameter=key>…
  "<function=",
  // MiMo variant: <tool_name>name</tool_name><tool_arguments>{…}
  "<tool_name>",
];

// Shortest partial marker prefix we accept, so a plain ``` fence is not held.
const MIN_PARTIAL_MARKER_LEN = 6;

// Start of a bare JSON tool call: {"name":
const JSON_START_RE = /\{\s*"name"\s*:/;
// Partial tail: `{`, `{\n`, `{ "`, `{"na`, … Qwen deltas are 1–35 chars and
// regularly break right after `{`, which used to leak the brace into the chat.
const JSON_PARTIAL_TAIL_RE = /\{\s*(?:"(?:n(?:a(?:m(?:e)?)?)?)?)?$/;

/**
 * Index where the first tool-call marker starts — full, or partial at the end
 * of the buffer (markers get split across SSE chunks). -1 when there is none.
 */
export function findToolCallMarkerStart(text: string): number {
  let earliest = -1;
  const take = (index: number) => {
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index;
    }
  };

  for (const marker of TOOL_CALL_MARKERS) {
    take(text.indexOf(marker));

    for (
      let len = Math.min(marker.length - 1, text.length);
      len >= MIN_PARTIAL_MARKER_LEN;
      len--
    ) {
      if (text.endsWith(marker.slice(0, len))) {
        take(text.length - len);
        break;
      }
    }
  }

  take(JSON_START_RE.exec(text)?.index ?? -1);
  take(JSON_PARTIAL_TAIL_RE.exec(text)?.index ?? -1);
  return earliest;
}

/**
 * Does the buffer look like a real call rather than a false marker hit (a
 * markdown fence)? Keeps large legitimate calls held instead of flushed.
 */
export function looksLikeToolCallStart(text: string): boolean {
  return (
    /```tool_call|<tool_call|<function\s*=|<tool_name>/i.test(text) ||
    /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(text) ||
    /"arguments"\s*:\s*\{/.test(text)
  );
}

/**
 * Removes balanced `{"name":…,"arguments":{…}}` objects. A regex cannot do this:
 * `\{[\s\S]*?\}` breaks on `}` inside string values and leaves JSON in the chat.
 */
export function stripInlineToolCallJson(text: string): string {
  let result = "";
  let i = 0;

  while (i < text.length) {
    if (text[i] === "{") {
      const extracted = extractBalancedJsonAt(text, i);
      const parsed = extracted ? tryParseJson(extracted.json) : undefined;
      if (
        extracted &&
        typeof parsed?.name === "string" &&
        argumentsOf(parsed) !== undefined
      ) {
        i = extracted.end;
        continue;
      }
    }
    result += text[i];
    i++;
  }

  return result;
}

/** Strips the wrapped forms of a tool call: fenced, tagged and bare JSON. */
export function stripToolCallBlocks(text: string): string {
  return stripInlineToolCallJson(
    text
      .replace(/```tool_call[\s\S]*?```/gi, "\n\n")
      .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "\n\n"),
  );
}

export function createToolCallChunk(params: {
  name: string;
  argumentsValue?: unknown;
  argumentsPart?: string;
  callId?: string;
}): AIStreamChunk {
  const args =
    params.argumentsPart ??
    (typeof params.argumentsValue === "string"
      ? params.argumentsValue
      : JSON.stringify(params.argumentsValue ?? {}));

  return {
    type: "tool_call",
    callId: params.callId ?? crypto.randomUUID(),
    name: params.name,
    argumentsPart: args,
  };
}

/** System prompt that pushes web models towards our tool-call syntax. */
export function buildToolsSystemPrompt(tools: AIToolDefinition[]): string {
  const compactTools = tools.map((t) => {
    const params = t.parameters as {
      properties?: Record<string, unknown>;
      required?: unknown;
    };
    return {
      name: t.name,
      args: Object.keys(params?.properties ?? {}).slice(0, 8),
      required: Array.isArray(params.required)
        ? params.required.slice(0, 8)
        : [],
      description: t.description.slice(0, 120),
    };
  });

  return [
    "# Tool usage protocol (MANDATORY)",
    "",
    "Always answer in the same language as the user's latest message.",
    "Never switch language unless the user explicitly asks.",
    "",
    "If the user asks to inspect files/folders, read project state, run checks, or gather info, you MUST call a tool first.",
    "Do not explain a plan before the tool call.",
    "Do NOT output markdown links to local files instead of tool calls.",
    "",
    "When a tool is needed, output ONLY one fenced block in this exact format:",
    "```tool_call",
    '{"name":"tool_name","arguments":{"param":"value"}}',
    "```",
    "",
    "Alternative accepted format (fallback only):",
    '<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>',
    "",
    "JSON validity is CRITICAL — a malformed call is dropped:",
    '- Every string value MUST be valid JSON: escape " as \\", newlines as \\n, backslashes as \\\\, tabs as \\t.',
    "- Close every brace and quote. The object must be complete and balanced.",
    "- Output NOTHING after the closing ``` — no markdown, no links, no commentary.",
    "- When passing file contents (oldString/newString/code), escape them as a single JSON string; do not paste raw multi-line text.",
    "",
    "Rules:",
    "- Call tools one at a time.",
    "- Include ALL required arguments.",
    "- After tool result, continue with either next tool_call or final answer.",
    "- Never output pseudo tool syntax mixed with prose.",
    "",
    "After tool result is returned, continue normally.",
    "",
    "Available tools (compact):",
    JSON.stringify(compactTools, null, 2),
  ].join("\n");
}

/**
 * Fallback parsers, most explicit first. The first one that finds anything wins
 * and its text is dropped — models mix internal instructions in around a call.
 */
const PARSERS: Array<{
  label: string;
  parse: (text: string) => AIStreamChunk[];
}> = [
  { label: "tool_call attribute", parse: parseAttributeTagCalls },
  { label: "xml function", parse: parseXmlFunctionCalls },
  { label: "tool_name/tool_arguments", parse: parseTagPairCalls },
  { label: "fenced", parse: parseCodeFenceCalls },
  { label: "bracket", parse: parseBracketCalls },
  { label: "plain", parse: parsePlainCalls },
  { label: "json", parse: parseJsonInlineCalls },
  { label: "loose json", parse: parseLooseJsonCalls },
  { label: "name+arguments", parse: parseNameArgumentsCalls },
  { label: "repaired json", parse: parseRepairedJsonCalls },
  { label: "prefixed", parse: parsePrefixedCalls },
  { label: "markdown file link", parse: parseMarkdownReadFileCalls },
];

/** `read_file, edit_file×3` — compact call list for the logs. */
export function summarizeToolCalls(chunks: readonly AIStreamChunk[]): string {
  const counts = new Map<string, number>();
  for (const chunk of chunks) {
    if (chunk.type !== "tool_call") continue;
    const name = chunk.name || "(unnamed)";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return (
    [...counts]
      .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
      .join(", ") || "(none)"
  );
}

/** Parses accumulated response text into tool calls, or yields it as text. */
export function* parseToolCallsFromText(
  text: string,
  options?: ToolCallParseOptions,
): Iterable<AIStreamChunk> {
  const log = (calls: AIStreamChunk[], label: string) =>
    options?.logger?.(
      `${options.logPrefix ?? ""}parsed ${calls.length} tool_call(s) from ${label} syntax: ${summarizeToolCalls(calls)}`,
    );

  const tagged = parseTaggedCalls(text);
  if (tagged.calls.length > 0) {
    log(tagged.calls, "<tool_call>");
    yield* tagged.calls;
    return;
  }

  for (const { label, parse } of PARSERS) {
    const calls = parse(text);
    if (calls.length === 0) continue;
    log(calls, label);
    yield* calls;
    return;
  }

  if (tagged.text.trim()) {
    yield { type: "text", content: tagged.text.trimEnd() };
  }
}

/** `<tool_call>{…}</tool_call>` pairs; unparsable ones stay as text. */
function parseTaggedCalls(text: string): {
  calls: AIStreamChunk[];
  text: string;
} {
  const OPEN = "<tool_call>";
  const CLOSE = "</tool_call>";
  const calls: AIStreamChunk[] = [];
  let buffered = "";
  let pos = 0;

  const keep = (raw: string) => {
    const trimmed = raw.trimEnd();
    if (trimmed) buffered += (buffered ? "\n" : "") + trimmed;
  };

  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN, pos);
    if (openIdx === -1) {
      keep(text.slice(pos));
      break;
    }
    keep(text.slice(pos, openIdx));

    const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      keep(text.slice(openIdx));
      break;
    }

    const parsed = tryParseJson(
      text.slice(openIdx + OPEN.length, closeIdx).trim(),
    );
    if (parsed) {
      calls.push(
        createToolCallChunk({
          name: parsed.name ?? "",
          argumentsValue: parsed.arguments ?? {},
        }),
      );
    } else {
      keep(text.slice(openIdx, closeIdx + CLOSE.length));
    }
    pos = closeIdx + CLOSE.length;
  }

  return { calls, text: buffered };
}

// The name lives in an attribute and the arguments follow as a bare object:
//   <tool_call name="get_errors">{"filePaths": []}</tool_call>
// The closing tag is optional — models drop it constantly.
const ATTRIBUTE_TAG_RE =
  /<tool_call\s+name\s*=\s*["']?([\w.:-]+)["']?\s*>([\s\S]*?)(?=<\/tool_call>|<tool_call\b|$)/gi;

function parseAttributeTagCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  for (const match of text.matchAll(ATTRIBUTE_TAG_RE)) {
    const name = match[1]?.trim();
    if (name) {
      calls.push({
        ...createToolCallChunk({
          name,
          argumentsValue: parseArgumentsBlock(match[2] ?? ""),
        }),
      });
    }
  }
  return calls;
}

function parseCodeFenceCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  for (const match of text.matchAll(/```tool_call\s*([\s\S]*?)```/g)) {
    const parsed = tryParseJson((match[1] ?? "").trim());
    if (typeof parsed?.name === "string" && parsed.name) {
      calls.push(
        createToolCallChunk({
          name: parsed.name,
          argumentsValue: argumentsOf(parsed) ?? {},
        }),
      );
    }
  }
  return calls;
}

function parseJsonInlineCalls(text: string): AIStreamChunk[] {
  const pattern =
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const calls: AIStreamChunk[] = [];

  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? "").trim();
    // Only well-formed arguments: the lazy `\{[\s\S]*?\}` often stops at a `}`
    // inside a value. A truncated capture is left to the repair fallbacks.
    const args = asObject(tryParseJson(match[2] ?? ""));
    if (name && args) {
      calls.push(createToolCallChunk({ name, argumentsValue: args }));
    }
  }

  return calls;
}

function parseLooseJsonCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];

  for (const raw of extractBalancedJsonObjects(text)) {
    const parsed = tryParseJson(raw);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const args = parsed ? argumentsOf(parsed) : undefined;
    // A plain object with a "name" but no arguments field is data, not a call.
    if (name && args !== undefined) {
      calls.push(createToolCallChunk({ name, argumentsValue: args }));
    }
  }

  return calls;
}

/**
 * Pulls `name` and the balanced arguments object separately. Saves calls whose
 * outer `{"name":…}` wrapper is broken while the arguments themselves are valid.
 */
function parseNameArgumentsCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  const nameRe = /"name"\s*:\s*"([^"]+)"/g;

  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(text)) !== null) {
    const name = (m[1] ?? "").trim();
    if (!name) continue;

    const argsKeyRe = /"(?:arguments|params|input)"\s*:\s*\{/g;
    argsKeyRe.lastIndex = m.index + m[0].length;
    const am = argsKeyRe.exec(text);
    if (!am) continue;

    const extracted = extractBalancedJsonAt(text, am.index + am[0].length - 1);
    if (!extracted) continue;

    const args = asObject(tryParseJson(extracted.json));
    if (!args || Object.keys(args).length === 0) continue;

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
    nameRe.lastIndex = extracted.end;
  }

  return calls;
}

function parseRepairedJsonCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  const startPattern = /\{\s*"name"\s*:/g;

  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(text)) !== null) {
    const repaired = repairToolCallJson(text, match.index);
    const parsed = repaired ? tryParseJson(repaired) : undefined;
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const args = parsed ? asObject(argumentsOf(parsed)) : undefined;

    // Empty/broken arguments are dropped: a bogus call can be destructive.
    if (name && args && Object.keys(args).length > 0) {
      calls.push(createToolCallChunk({ name, argumentsValue: args }));
      startPattern.lastIndex = match.index + (repaired as string).length;
    }
  }

  return calls;
}

function parsePrefixedCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const prefixIdx = text.indexOf("tool_call", searchFrom);
    if (prefixIdx === -1) break;

    const objStart = text.indexOf("{", prefixIdx);
    if (objStart === -1) break;

    const extracted = extractBalancedJsonAt(text, objStart);
    if (!extracted) break;

    const parsed = tryParseJson(extracted.json);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: (parsed && argumentsOf(parsed)) ?? {},
        }),
      );
    }
    searchFrom = extracted.end;
  }

  return calls;
}

function parseBracketCalls(text: string): AIStreamChunk[] {
  return callsFromPattern(text, /\[([a-zA-Z_][\w]*)\(([^\]]*)\)\]/g, 1, 2);
}

function parsePlainCalls(text: string): AIStreamChunk[] {
  return callsFromPattern(
    text,
    /(^|\s)([a-zA-Z_][\w]*)\(([^\n)]*)\)(?=\s|$)/gm,
    2,
    3,
  );
}

/** `tool(key="value")` style pseudo-calls, with or without brackets. */
function callsFromPattern(
  text: string,
  pattern: RegExp,
  nameGroup: number,
  argsGroup: number,
): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  for (const match of text.matchAll(pattern)) {
    const name = match[nameGroup]?.trim();
    if (!name) continue;
    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: parseKeyValueArgs(match[argsGroup] ?? ""),
      }),
    );
  }
  return calls;
}

function parseMarkdownReadFileCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];

  for (const match of text.matchAll(/\[[^\]]*\]\((file:\/\/[^)\s]+)\)/g)) {
    const filePath = fileUriToPath(match[1] ?? "");
    if (!filePath) continue;

    let startLine = 1;
    let endLine = 2000;
    const index = match.index ?? 0;
    const range = text
      .slice(Math.max(0, index - 80), index + 180)
      .match(/lines?\s+(\d+)\s+to\s+(\d+)/i);
    if (range) {
      const s = Number(range[1]);
      const e = Number(range[2]);
      if (Number.isFinite(s) && s > 0) startLine = s;
      if (Number.isFinite(e) && e >= startLine) endLine = e;
    }

    calls.push(
      createToolCallChunk({
        name: "read_file",
        argumentsValue: { filePath, startLine, endLine },
      }),
    );
  }

  return calls;
}

// MiMo/Qwen-Coder native markup:
//   <tool_call><function=read_file><parameter=path>/a/b.ts</parameter></function></tool_call>
// Closing tags are frequently dropped, so both are optional: a block runs to the
// next tag or to the end.
const XML_FUNCTION_RE =
  /<function\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/function>|<function\s*=|<\/tool_call>|$)/gi;
const XML_PARAMETER_RE =
  /<parameter\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter\s*=|<\/function>|<\/tool_call>|$)/gi;

function parseXmlFunctionCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];
  for (const match of text.matchAll(XML_FUNCTION_RE)) {
    const name = match[1]?.trim();
    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: parseXmlParameters(match[2] ?? ""),
        }),
      );
    }
  }
  return calls;
}

// Second MiMo variant: name and arguments in separate tags. The arguments block
// is optional (calls without parameters) and often left unclosed.
const TAG_TOOL_NAME_RE =
  /<tool_name>\s*([\w.:-]+)\s*(?:<\/tool_name>|$)([\s\S]*?)(?=<tool_name>|$)/gi;
const TAG_TOOL_ARGS_RE =
  /<tool_arguments>([\s\S]*?)(?:<\/tool_arguments>|<\/tool_call>|$)/i;

function parseTagPairCalls(text: string): AIStreamChunk[] {
  const calls: AIStreamChunk[] = [];

  for (const match of text.matchAll(TAG_TOOL_NAME_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    const argsBlock = TAG_TOOL_ARGS_RE.exec(match[2] ?? "");
    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: argsBlock
          ? parseArgumentsBlock(argsBlock[1] ?? "")
          : {},
      }),
    );
  }

  return calls;
}

/**
 * Body of a tag whose name lives outside it: usually a JSON object of
 * arguments, sometimes `<parameter=…>` pairs.
 *
 * Models often repeat the whole call envelope inside the tag
 * (`<tool_call name="read_file">{"name":"read_file","arguments":{…}}`), so an
 * envelope is unwrapped to its arguments — otherwise the real parameters end up
 * nested one level too deep and the tool sees none of them.
 */
function parseArgumentsBlock(raw: string): Record<string, unknown> {
  const body = raw.trim();
  if (!body) return {};

  const start = body.indexOf("{");
  if (start !== -1) {
    const balanced = extractBalancedJsonAt(body, start);
    const parsed = balanced ? tryParseJson(balanced.json) : undefined;
    if (parsed) {
      const inner =
        typeof parsed.name === "string"
          ? asObject(argumentsOf(parsed))
          : undefined;
      return inner ?? asObject(parsed) ?? {};
    }
  }

  return parseXmlParameters(body);
}

function parseXmlParameters(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const param of body.matchAll(XML_PARAMETER_RE)) {
    const key = param[1]?.trim();
    if (key) args[key] = coerceValue(param[2] ?? "", true);
  }
  return args;
}

function parseKeyValueArgs(rawArgs: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const pairRegex =
    /([a-zA-Z_][\w]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,]+)(?:,\s*|$)/g;

  for (const pair of rawArgs.matchAll(pairRegex)) {
    result[pair[1]] = coerceValue(pair[2].trim(), false);
  }
  return result;
}

/** Turns a textual value into its JSON type (quotes, numbers, booleans, JSON). */
function coerceValue(raw: string, xml: boolean): unknown {
  // For XML the leading newline is markup and trailing spaces precede the tag.
  const value = xml ? raw.replace(/^\r?\n/, "").replace(/\s+$/, "") : raw;
  if (!value) return "";

  if (!xml) {
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      return value.slice(1, -1);
    }
    if (value === "null") return null;
  }

  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (xml ? /^-?\d+(\.\d+)?$/.test(value) : !Number.isNaN(Number(value))) {
    return Number(value);
  }
  if (xml && /^[[{]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // not JSON — keep as string
    }
  }
  return value;
}

/**
 * Best-effort repair of the broken JSON small models emit: trailing garbage,
 * missing braces/quotes, raw newlines and unescaped quotes inside values.
 *
 * Quote heuristic: a `"` inside a string closes it only when the next
 * significant char is structural (`,` `:` `}` `]`) or the end; otherwise it is
 * escaped. The result must still pass JSON.parse at the call site.
 */
function repairToolCallJson(text: string, start: number): string | undefined {
  if (text[start] !== "{") return undefined;

  let out = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        if (next === undefined || ",:}]".includes(next)) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      } else if (ch === "\n") {
        out += "\\n";
      } else if (ch === "\r") {
        out += "\\r";
      } else if (ch === "\t") {
        out += "\\t";
      } else {
        out += ch;
      }
      continue;
    }

    out += ch;
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return out; // object closed — drop whatever trails it
    }
  }

  // Ran out of input: close the dangling string and braces.
  if (inString) out += '"';
  return out + "}".repeat(Math.max(0, depth));
}

function extractBalancedJsonAt(
  text: string,
  start: number,
): { json: string; end: number } | undefined {
  if (text[start] !== "{") return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return { json: text.slice(start, i + 1), end: i + 1 };
    }
  }

  return undefined;
}

/** Single pass so a long unbalanced buffer cannot degrade to O(n²). */
function extractBalancedJsonObjects(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0 && --depth === 0 && start !== -1) {
      result.push(text.slice(start, i + 1));
      start = -1;
    }
  }

  return result;
}

interface ParsedCall {
  name?: string;
  arguments?: unknown;
  params?: unknown;
  input?: unknown;
}

function tryParseJson(raw: string): ParsedCall | undefined {
  try {
    return JSON.parse(raw) as ParsedCall;
  } catch {
    return undefined;
  }
}

function argumentsOf(parsed: ParsedCall): unknown {
  return parsed.arguments ?? parsed.params ?? parsed.input;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fileUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:"
      ? decodeURIComponent(parsed.pathname)
      : undefined;
  } catch {
    return undefined;
  }
}
