import type {
  AIRequestParams,
  AIStreamChunk,
  AIToolDefinition,
} from "../types";

export type ToolPromptMessageContent =
  string | Array<{ type?: string; text?: string }>;

export interface ToolCallParseOptions {
  logger?: (message: string) => void;
  logPrefix?: string;
}

export const DEFAULT_TOOL_CALL_MARKERS = [
  "```tool_call",
  "<tool_call>",
  "`tool_call {",
  "tool_call {",
  "\ntool_call {",
  // Нативный XML-формат MiMo/Qwen-Coder: <function=name><parameter=key>...
  "<function=",
  // Второй вариант у MiMo: <tool_name>name</tool_name><tool_arguments>{...}
  "<tool_name>",
];

// Минимальная длина частичного префикса маркера при стриминге.
// Нужна, чтобы не ловить ложные срабатывания на обычный "```" код-блок.
const MIN_PARTIAL_TOOL_MARKER_LEN = 6;

/**
 * Возвращает индекс начала первого tool call маркера в тексте
 * (полного или частичного в конце строки при стриминге), либо -1.
 */
export function findToolCallMarkerStart(
  text: string,
  markers: string[] = DEFAULT_TOOL_CALL_MARKERS,
): number {
  let earliest = -1;

  for (const marker of markers) {
    // Полное вхождение
    const idx = text.indexOf(marker);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }

    // Частичное вхождение в конце (маркер мог быть разбит по SSE чанкам)
    for (
      let len = Math.min(marker.length - 1, text.length);
      len >= MIN_PARTIAL_TOOL_MARKER_LEN;
      len--
    ) {
      if (text.endsWith(marker.slice(0, len))) {
        const start = text.length - len;
        if (earliest === -1 || start < earliest) {
          earliest = start;
        }
        break;
      }
    }
  }

  // Дополнительно распознаём начало "сырого" JSON tool call вида
  // {"name": "...", "arguments": {...}}. Модели часто выводят его без обёртки
  // ```tool_call / <tool_call>, и без этой проверки он утекал бы в чат как
  // обычный текст вместо структурного вызова инструмента.
  const jsonStart = findJsonToolCallStart(text);
  if (jsonStart !== -1 && (earliest === -1 || jsonStart < earliest)) {
    earliest = jsonStart;
  }

  return earliest;
}

// Полное вхождение начала JSON tool-call объекта (с учётом пробелов): {"name":
const JSON_TOOLCALL_START_RE = /\{\s*"name"\s*:/;
// Частичный префикс в конце чанка: `{`, `{\n`, `{ "`, `{"na`, … Компактная форма
// `{"name"` здесь не годится: у Qwen дельты приходят по 1–35 символов, и чанк
// регулярно обрывается сразу после `{` или `{\n`. Тогда открывающая скобка
// утекала в чат как текст, а следующий чанк с `"name":` было уже не с чем
// склеить — вызов оставался видимым JSON'ом в ответе.
// Ложное удержание обычного текста на `{` разгребает MAX_TOOLCALL_HOLD_BUFFER_CHARS.
const JSON_TOOLCALL_PARTIAL_TAIL_RE = /\{\s*(?:"(?:n(?:a(?:m(?:e)?)?)?)?)?$/;

/**
 * Возвращает индекс начала JSON tool-call объекта ({"name": ...) в тексте,
 * включая частичный префикс в конце строки (объект мог быть разбит по SSE
 * чанкам), либо -1.
 */
function findJsonToolCallStart(text: string): number {
  const full = JSON_TOOLCALL_START_RE.exec(text);
  let earliest = full ? full.index : -1;

  const partial = JSON_TOOLCALL_PARTIAL_TAIL_RE.exec(text);
  if (partial && (earliest === -1 || partial.index < earliest)) {
    earliest = partial.index;
  }

  return earliest;
}

/**
 * Похоже ли накопленное на настоящий tool_call (а не ложное срабатывание
 * маркера вроде markdown code-block). Используется, чтобы не «сбрасывать»
 * большие легитимные вызовы (например replace_string_in_file с целым файлом)
 * как обычный текст при достижении лимита hold-буфера.
 */
export function looksLikeToolCallStart(text: string): boolean {
  return (
    /```tool_call/i.test(text) ||
    /<tool_call>/i.test(text) ||
    /<function\s*=/i.test(text) ||
    /<tool_name>/i.test(text) ||
    /"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/.test(text) ||
    /"arguments"\s*:\s*\{/.test(text)
  );
}

/**
 * Удаляет из текста сбалансированные JSON-объекты tool-call формата
 * ({"name":..., "arguments":{...}}), корректно учитывая вложенные скобки и
 * строки. Regex-замены с `\{[\s\S]*?\}` ломались на вложенных `}` внутри
 * строковых значений (большие oldString/newString) и оставляли JSON в чате.
 */
export function stripInlineToolCallJson(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const extracted = extractBalancedJsonAt(text, i);
      if (extracted) {
        const parsed = tryParseJson(extracted.json);
        const isToolCall =
          !!parsed &&
          typeof parsed.name === "string" &&
          (parsed.arguments !== undefined ||
            parsed.params !== undefined ||
            parsed.input !== undefined);
        if (isToolCall) {
          i = extracted.end;
          continue;
        }
      }
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * Универсальный фабричный helper для формирования tool_call чанка.
 * Используется всеми провайдерами и парсерами, чтобы структура была единообразной.
 */
export function createToolCallChunk(params: {
  name: string;
  argumentsValue?: unknown;
  argumentsPart?: string;
  callId?: string;
}): AIStreamChunk {
  const argsAsString =
    params.argumentsPart !== undefined
      ? params.argumentsPart
      : typeof params.argumentsValue === "string"
        ? params.argumentsValue
        : JSON.stringify(params.argumentsValue ?? {});

  return {
    type: "tool_call",
    callId: params.callId ?? crypto.randomUUID(),
    name: params.name,
    argumentsPart: argsAsString,
  };
}

/**
 * Эвристически выбирает подмножество tools для инжекта в prompt,
 * чтобы не переполнять контекст и снижать ошибки upstream.
 */
export function selectToolsForPrompt(
  tools: AIToolDefinition[],
  messageContent: ToolPromptMessageContent,
  toolMode: AIRequestParams["toolMode"],
): AIToolDefinition[] {
  // Пользовательский режим: инжектим ВСЕ доступные инструменты.
  // Переменные нужны ниже только чтобы не ломать подпись/совместимость.
  void messageContent;
  void toolMode;
  return tools;
}

/**
 * Формирует system_message с описанием инструментов в формате,
 * который хорошо подталкивает web‑модели к tool call синтаксису.
 */
export function buildToolsSystemPrompt(tools: AIToolDefinition[]): string {
  const compactTools = tools.map((t) => {
    const properties =
      (t.parameters as { properties?: Record<string, unknown> })?.properties ??
      {};
    const argKeys = Object.keys(properties).slice(0, 8);
    const required = Array.isArray(
      (t.parameters as { required?: unknown }).required,
    )
      ? ((t.parameters as { required?: string[] }).required ?? []).slice(0, 8)
      : [];
    return {
      name: t.name,
      args: argKeys,
      required,
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
 * Парсит накопленный текст ответа:
 * — <tool_call>{...}</tool_call> теги → AIToolCallChunk
 * — [tool_name(key="value")] псевдо-вызовы → AIToolCallChunk
 * — tool_name(key="value") без [] → AIToolCallChunk
 * — остальной текст → AITextChunk
 */
export function* parseToolCallsFromText(
  text: string,
  options?: ToolCallParseOptions,
): Iterable<AIStreamChunk> {
  const OPEN = "<tool_call>";
  const CLOSE = "</tool_call>";

  const logger = options?.logger;
  const logPrefix = options?.logPrefix ?? "";

  let pos = 0;
  let toolCallCount = 0;
  let bufferedText = "";

  while (pos < text.length) {
    const openIdx = text.indexOf(OPEN, pos);
    if (openIdx === -1) {
      const remaining = text.slice(pos).trimEnd();
      if (remaining) {
        bufferedText += (bufferedText ? "\n" : "") + remaining;
      }
      break;
    }

    if (openIdx > pos) {
      const before = text.slice(pos, openIdx).trimEnd();
      if (before) {
        bufferedText += (bufferedText ? "\n" : "") + before;
      }
    }

    const closeIdx = text.indexOf(CLOSE, openIdx + OPEN.length);
    if (closeIdx === -1) {
      const rest = text.slice(openIdx).trimEnd();
      if (rest) {
        bufferedText += (bufferedText ? "\n" : "") + rest;
      }
      break;
    }

    const jsonStr = text.slice(openIdx + OPEN.length, closeIdx).trim();
    try {
      const parsed = JSON.parse(jsonStr) as {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
      const name = parsed.name ?? "";
      const argsRaw = parsed.arguments ?? {};
      toolCallCount++;
      yield createToolCallChunk({
        name,
        argumentsValue: argsRaw,
      });
    } catch {
      const raw = text.slice(openIdx, closeIdx + CLOSE.length);
      bufferedText += (bufferedText ? "\n" : "") + raw;
    }

    pos = closeIdx + CLOSE.length;
  }

  if (toolCallCount > 0) {
    logger?.(
      `${logPrefix}parsed ${toolCallCount} tool_call(s) from <tool_call>`,
    );
    // При наличии tool_call не показываем промежуточный служебный текст
    // (план, pseudo calls, transcript), чтобы он не утекал пользователю в чат.
    return;
  }

  // Нативный формат MiMo (и Qwen-Coder): <function=name><parameter=key>value.
  // Идёт сразу после JSON-варианта, потому что модель мешает его с обычным
  // текстом, и без разбора в чат утекают куски разметки (`</tool_call>`).
  const xmlFunctionCalls = parseXmlFunctionToolCallsFromText(text);
  if (xmlFunctionCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${xmlFunctionCalls.calls.length} tool_call(s) from xml function syntax`,
    );

    for (const call of xmlFunctionCalls.calls) {
      yield call;
    }

    return;
  }

  // Второй нативный вариант MiMo: имя и аргументы отдельными тегами.
  const tagPairCalls = parseTagPairToolCallsFromText(text);
  if (tagPairCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${tagPairCalls.calls.length} tool_call(s) from tool_name/tool_arguments syntax`,
    );

    for (const call of tagPairCalls.calls) {
      yield call;
    }

    return;
  }

  const codeFenceCalls = parseToolCallCodeFenceFromText(text);
  if (codeFenceCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${codeFenceCalls.calls.length} tool_call(s) from fenced syntax`,
    );

    for (const call of codeFenceCalls.calls) {
      yield call;
    }

    // Не эмитим текст рядом с tool_call, чтобы не показывать внутренние инструкции.
    return;
  }

  const bracketCalls = parseBracketToolCallsFromText(text);
  if (bracketCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${bracketCalls.calls.length} tool_call(s) from bracket syntax`,
    );

    for (const call of bracketCalls.calls) {
      yield call;
    }

    // Не эмитим текст рядом с tool_call, чтобы не показывать внутренние инструкции.
    return;
  }

  const plainCalls = parsePlainToolCallsFromText(text);
  if (plainCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${plainCalls.calls.length} tool_call(s) from plain syntax`,
    );

    for (const call of plainCalls.calls) {
      yield call;
    }

    // Не эмитим текст рядом с tool_call, чтобы не показывать внутренние инструкции.
    return;
  }

  const jsonInlineCalls = parseJsonInlineToolCallsFromText(text);
  if (jsonInlineCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${jsonInlineCalls.calls.length} tool_call(s) from json syntax`,
    );

    for (const call of jsonInlineCalls.calls) {
      yield call;
    }

    // Не эмитим текст рядом с tool_call, чтобы не показывать внутренние инструкции.
    return;
  }

  const looseJsonCalls = parseLooseJsonToolCallsFromText(text);
  if (looseJsonCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${looseJsonCalls.calls.length} tool_call(s) from loose json syntax`,
    );

    for (const call of looseJsonCalls.calls) {
      yield call;
    }

    return;
  }

  // Частый брак: объект `arguments` сам по себе валиден и сбалансирован, а
  // сломана только внешняя обёртка {"name":...} (лишняя кавычка/недостающая `}`
  // на конце). Вытаскиваем name и balanced-объект arguments напрямую — обёртку
  // игнорируем.
  const nameArgsCalls = parseNameArgumentsToolCallsFromText(text);
  if (nameArgsCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${nameArgsCalls.calls.length} tool_call(s) from name+arguments syntax`,
    );

    for (const call of nameArgsCalls.calls) {
      yield call;
    }

    return;
  }

  // Битый JSON (несбалансированные скобки, сырые переводы строк/кавычки,
  // мусорный хвост) — частый брак маленьких моделей. Чиним best-effort.
  const repairedCalls = parseRepairedJsonToolCallsFromText(text);
  if (repairedCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${repairedCalls.calls.length} tool_call(s) from repaired json syntax`,
    );

    for (const call of repairedCalls.calls) {
      yield call;
    }

    return;
  }

  const prefixedCalls = parsePrefixedToolCallFromText(text);
  if (prefixedCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${prefixedCalls.calls.length} tool_call(s) from prefixed syntax`,
    );

    for (const call of prefixedCalls.calls) {
      yield call;
    }

    return;
  }

  const markdownReadCalls = parseMarkdownReadFileCallsFromText(text);
  if (markdownReadCalls.calls.length > 0) {
    logger?.(
      `${logPrefix}parsed ${markdownReadCalls.calls.length} tool_call(s) from markdown file links`,
    );

    for (const call of markdownReadCalls.calls) {
      yield call;
    }

    return;
  }

  if (bufferedText.trim()) {
    yield { type: "text", content: bufferedText.trimEnd() };
  }
}

function parseToolCallCodeFenceFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const pattern = /```tool_call\s*([\s\S]*?)```/g;
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = (match[1] ?? "").trim();
    if (!raw) continue;

    const parsed = tryParseJson(raw);
    const name = typeof parsed?.name === "string" ? parsed.name : "";
    const argsRaw = parsed?.arguments ?? parsed?.params ?? parsed?.input ?? {};

    if (!name) continue;

    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: argsRaw,
      }),
    );

    remainingText = remainingText.replace(match[0], "").trim();
  }

  return { calls, remainingText };
}

function parseJsonInlineToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const pattern =
    /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const name = (match[1] ?? "").trim();
    if (!name) continue;

    // Только корректно распарсенные аргументы: ленивый `\{[\s\S]*?\}` нередко
    // захватывает кусок объекта (обрыв на первом `}` внутри значения). Битый
    // захват не эмитим — пусть его подхватит looseJson / repair-фолбэк, а не
    // отправляем вызов с пустыми/обрезанными аргументами.
    const args = tryParseJson(match[2] ?? "");
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;

    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: args,
      }),
    );

    remainingText = remainingText.replace(match[0], "").trim();
  }

  return { calls, remainingText };
}

function parseLooseJsonToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  const jsonObjects = extractBalancedJsonObjects(text);
  for (const raw of jsonObjects) {
    const parsed = tryParseJson(raw);
    if (!parsed) continue;

    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) continue;

    // Требуем явное поле аргументов: произвольный JSON с полем "name", но без
    // arguments/params/input — это данные, а не вызов инструмента.
    const argsRaw = parsed.arguments ?? parsed.params ?? parsed.input;
    if (argsRaw === undefined) continue;

    calls.push(
      createToolCallChunk({
        name,
        argumentsValue: argsRaw,
      }),
    );

    remainingText = remainingText.replace(raw, " ").trim();
  }

  return { calls, remainingText };
}

/**
 * Извлекает tool_call по отдельности: `name` через regex и сбалансированный
 * объект `arguments`/`params`/`input` через скобочный экстрактор. Спасает случаи,
 * когда внешняя обёртка {"name":...} битая (лишняя кавычка, нет закрывающей `}`,
 * мусорный хвост), но сам объект аргументов — валидный JSON. Если аргументы не
 * парсятся (например из-за неэкранированных кавычек в значениях) — пропускаем.
 */
function parseNameArgumentsToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
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

    const braceStart = am.index + am[0].length - 1;
    const extracted = extractBalancedJsonAt(text, braceStart);
    if (!extracted) continue;

    const args = tryParseJson(extracted.json);
    if (!args || typeof args !== "object" || Array.isArray(args)) continue;
    if (Object.keys(args as Record<string, unknown>).length === 0) continue;

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
    nameRe.lastIndex = extracted.end;
  }

  return { calls, remainingText: text };
}

/**
 * Best-effort починка битого JSON tool-call объекта, который часто выдают
 * маленькие модели (например qwen flash): мусорный хвост после объекта,
 * недостающие закрывающие скобки/кавычки, сырые переводы строк и
 * неэкранированные кавычки внутри строковых значений.
 *
 * Эвристика по кавычкам: внутри строки `"` считается закрывающей только если
 * следующий значимый символ структурный (`,` `:` `}` `]`) либо конец; иначе это
 * неэкранированная кавычка внутри значения — экранируем её. Это не панацея
 * (контент, сам похожий на JSON, развалит разбор), поэтому результат ОБЯЗАТЕЛЬНО
 * проверяется через JSON.parse у вызывающего — невалидное чинить не пытаемся.
 *
 * Возвращает строку-кандидат для JSON.parse, либо undefined.
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
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        const next = text[j];
        if (
          next === undefined ||
          next === "," ||
          next === ":" ||
          next === "}" ||
          next === "]"
        ) {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "{") {
      depth++;
      out += ch;
      continue;
    }
    if (ch === "}") {
      depth--;
      out += ch;
      if (depth === 0) {
        // Объект закрылся — мусорный хвост после него отбрасываем.
        return out;
      }
      continue;
    }
    out += ch;
  }

  // Дошли до конца без баланса: авто-закрываем строку и недостающие скобки.
  if (inString) {
    out += '"';
  }
  while (depth > 0) {
    out += "}";
    depth--;
  }

  return out;
}

function parseRepairedJsonToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const calls: AIStreamChunk[] = [];
  const startPattern = /\{\s*"name"\s*:/g;

  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(text)) !== null) {
    const repaired = repairToolCallJson(text, match.index);
    if (!repaired) continue;

    const parsed = tryParseJson(repaired);
    if (!parsed) continue;

    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!name) continue;

    const argsRaw = parsed.arguments ?? parsed.params ?? parsed.input;
    // Требуем непустой объект аргументов: пустой/битый вызов не эмитим, чтобы не
    // слать заведомо нерабочий (а то и разрушительный) tool_call.
    if (
      !argsRaw ||
      typeof argsRaw !== "object" ||
      Array.isArray(argsRaw) ||
      Object.keys(argsRaw as Record<string, unknown>).length === 0
    ) {
      continue;
    }

    calls.push(createToolCallChunk({ name, argumentsValue: argsRaw }));
    startPattern.lastIndex = match.index + repaired.length;
  }

  return { calls, remainingText: text };
}

function parsePrefixedToolCallFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const prefixIdx = text.indexOf("tool_call", searchFrom);
    if (prefixIdx === -1) break;

    const objStart = text.indexOf("{", prefixIdx);
    if (objStart === -1) break;

    const extracted = extractBalancedJsonAt(text, objStart);
    if (!extracted) {
      break;
    }

    const parsed = tryParseJson(extracted.json);
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    const argsRaw = parsed?.arguments ?? parsed?.params ?? parsed?.input ?? {};

    if (name) {
      calls.push(
        createToolCallChunk({
          name,
          argumentsValue: argsRaw,
        }),
      );

      const fullSegment = text.slice(prefixIdx, extracted.end);
      remainingText = remainingText.replace(fullSegment, " ").trim();
    }

    searchFrom = extracted.end;
  }

  return { calls, remainingText };
}

function extractBalancedJsonAt(
  text: string,
  start: number,
): { json: string; end: number } | undefined {
  if (start < 0 || start >= text.length || text[start] !== "{") {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return {
          json: text.slice(start, i + 1),
          end: i + 1,
        };
      }
    }
  }

  return undefined;
}

function extractBalancedJsonObjects(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          result.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return result;
}

// Нативная разметка вызова у MiMo/Qwen-Coder:
//   <tool_call><function=read_file><parameter=path>/a/b.ts</parameter></function></tool_call>
// Закрывающие теги модель нередко теряет, поэтому и `</function>`, и
// `</parameter>` опциональны — блок тогда тянется до следующего тега/конца.
const XML_FUNCTION_RE =
  /<function\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/function>|<function\s*=|<\/tool_call>|$)/gi;
const XML_PARAMETER_RE =
  /<parameter\s*=\s*([\w.:-]+)\s*>([\s\S]*?)(?=<\/parameter>|<parameter\s*=|<\/function>|<\/tool_call>|$)/gi;

/** Приводит текстовое значение параметра к JSON-типу (числа/булевы/объекты). */
function coerceXmlParameterValue(raw: string): unknown {
  // Ведущий перевод строки — часть разметки, а не значения; хвостовые пробелы
  // модель добавляет перед закрывающим тегом.
  const value = raw.replace(/^\r?\n/, "").replace(/\s+$/, "");
  if (!value) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^[[{]/.test(value)) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // не JSON — оставляем строкой
    }
  }
  return value;
}

function parseXmlFunctionToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
} {
  const calls: AIStreamChunk[] = [];

  for (const match of text.matchAll(XML_FUNCTION_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;

    const args: Record<string, unknown> = {};
    for (const param of (match[2] ?? "").matchAll(XML_PARAMETER_RE)) {
      const key = param[1]?.trim();
      if (!key) continue;
      args[key] = coerceXmlParameterValue(param[2] ?? "");
    }

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
  }

  return { calls };
}

// Второй нативный вариант MiMo: имя и аргументы отдельными тегами —
//   <tool_name>list_dir</tool_name>
//   <tool_arguments>{ "path": "/a/b" }</tool_arguments>
// Блок аргументов необязателен (вызовы без параметров) и, как обычно у моделей,
// может остаться незакрытым.
const TAG_TOOL_NAME_RE =
  /<tool_name>\s*([\w.:-]+)\s*(?:<\/tool_name>|$)([\s\S]*?)(?=<tool_name>|$)/gi;
const TAG_TOOL_ARGS_RE =
  /<tool_arguments>([\s\S]*?)(?:<\/tool_arguments>|<\/tool_call>|$)/i;

function parseTagPairToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
} {
  const calls: AIStreamChunk[] = [];

  for (const match of text.matchAll(TAG_TOOL_NAME_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;

    const argsBlock = TAG_TOOL_ARGS_RE.exec(match[2] ?? "");
    const args = argsBlock ? parseToolArgumentsBlock(argsBlock[1] ?? "") : {};

    calls.push(createToolCallChunk({ name, argumentsValue: args }));
  }

  return { calls };
}

/** Тело <tool_arguments>: обычно JSON, но встречаются и <parameter=…>-пары. */
function parseToolArgumentsBlock(raw: string): Record<string, unknown> {
  const body = raw.trim();
  if (!body) return {};

  const start = body.indexOf("{");
  if (start !== -1) {
    const balanced = extractBalancedJsonAt(body, start);
    const parsed = balanced ? tryParseJson(balanced.json) : undefined;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  }

  const args: Record<string, unknown> = {};
  for (const param of body.matchAll(XML_PARAMETER_RE)) {
    const key = param[1]?.trim();
    if (!key) continue;
    args[key] = coerceXmlParameterValue(param[2] ?? "");
  }
  return args;
}

function tryParseJson(
  raw: string,
):
  | { name?: string; arguments?: unknown; params?: unknown; input?: unknown }
  | undefined {
  try {
    return JSON.parse(raw) as {
      name?: string;
      arguments?: unknown;
      params?: unknown;
      input?: unknown;
    };
  } catch {
    return undefined;
  }
}

function parseMarkdownReadFileCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  const linkPattern = /\[[^\]]*\]\((file:\/\/[^)\s]+)\)/g;

  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(text)) !== null) {
    const uri = match[1];
    if (!uri) continue;

    const filePath = fileUriToPath(uri);
    if (!filePath) continue;

    let startLine = 1;
    let endLine = 2000;

    const windowText = text.slice(
      Math.max(0, match.index - 80),
      match.index + 180,
    );
    const range = windowText.match(/lines?\s+(\d+)\s+to\s+(\d+)/i);
    if (range) {
      const s = Number(range[1]);
      const e = Number(range[2]);
      if (Number.isFinite(s) && s > 0) startLine = s;
      if (Number.isFinite(e) && e >= startLine) endLine = e;
    }

    calls.push(
      createToolCallChunk({
        name: "read_file",
        argumentsValue: {
          filePath,
          startLine,
          endLine,
        },
      }),
    );

    remainingText = remainingText.replace(match[0], "").trim();
  }

  return { calls, remainingText };
}

function fileUriToPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") {
      return undefined;
    }
    return decodeURIComponent(parsed.pathname);
  } catch {
    return undefined;
  }
}

function parseBracketToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const pattern = /\[([a-zA-Z_][\w]*)\(([^\]]*)\)\]/g;
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const toolName = match[1]?.trim();
    const rawArgs = match[2] ?? "";
    if (!toolName) continue;

    const args = parseBracketArgs(rawArgs);
    calls.push(
      createToolCallChunk({
        name: toolName,
        argumentsValue: args,
      }),
    );

    remainingText = remainingText.replace(match[0], "").trim();
  }

  return { calls, remainingText };
}

function parsePlainToolCallsFromText(text: string): {
  calls: AIStreamChunk[];
  remainingText: string;
} {
  const pattern = /(^|\s)([a-zA-Z_][\w]*)\(([^\n)]*)\)(?=\s|$)/gm;
  const calls: AIStreamChunk[] = [];
  let remainingText = text;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const toolName = match[2]?.trim();
    const rawArgs = match[3] ?? "";
    if (!toolName) continue;

    const args = parseBracketArgs(rawArgs);
    calls.push(
      createToolCallChunk({
        name: toolName,
        argumentsValue: args,
      }),
    );

    remainingText = remainingText.replace(match[0], " ").trim();
  }

  return { calls, remainingText };
}

function parseBracketArgs(rawArgs: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const pairRegex =
    /([a-zA-Z_][\w]*)\s*=\s*("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^,]+)(?:,\s*|$)/g;
  let pair: RegExpExecArray | null;

  while ((pair = pairRegex.exec(rawArgs)) !== null) {
    const key = pair[1];
    let valueRaw = pair[2].trim();

    if (
      (valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
      (valueRaw.startsWith("'") && valueRaw.endsWith("'"))
    ) {
      valueRaw = valueRaw.slice(1, -1);
      result[key] = valueRaw;
      continue;
    }

    if (valueRaw === "true") {
      result[key] = true;
      continue;
    }
    if (valueRaw === "false") {
      result[key] = false;
      continue;
    }
    if (valueRaw === "null") {
      result[key] = null;
      continue;
    }

    const num = Number(valueRaw);
    if (!Number.isNaN(num)) {
      result[key] = num;
      continue;
    }

    result[key] = valueRaw;
  }

  return result;
}
