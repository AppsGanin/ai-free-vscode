import {
  findToolCallMarkerStart,
  looksLikeToolCallStart,
  parseToolCallsFromText,
  stripInlineToolCallJson,
} from "./ToolCalling";
import type { AIStreamChunk } from "../types";

// Длина hold-буфера, после которой непохожий на tool_call текст сбрасываем как
// обычный текст (ложное срабатывание маркера на markdown/коде).
const MAX_TOOLCALL_HOLD_BUFFER_CHARS = 4096;
// Жёсткий предел для подтверждённых tool_call (большие аргументы вроде целого
// файла): держим до этого размера, прежде чем сдаться.
const MAX_TOOLCALL_HARD_CAP_CHARS = 262144;
// Сколько последних символов придерживаем, чтобы поймать частичный маркер на
// границе чанков (длина "```tool_call" минус 1).
const TOOL_MARKER_HOLDBACK_CHARS = 11;

// Маркеры фейкового СЛЕДУЮЩЕГО хода диалога, которые маленькие модели дописывают
// после своего ответа: они «доигрывают» склеенный транскрипт и эхом повторяют
// ролевые префиксы (`User:`/`Assistant:`) и наш плейсхолдер результата
// инструмента (`[Tool result id=...]`). Привязка к началу строки и очень
// специфичный `[tool result id=` минимизируют ложные срезы легитимного текста.
// Общий для всех провайдеров (Qwen/DeepSeek/Kimi склеивают диалог похоже).
const TRANSCRIPT_CUT_PATTERN =
  /(?:\n|^)[ \t]*(?:user|assistant)[ \t]*:|\[tool result id=/i;
// Длина hold-буфера для ловли частичной границы на стыке чанков
// (len("[Tool result id=") - 1).
const TRANSCRIPT_CUT_HOLDBACK_CHARS = 15;

/**
 * Закрывающие теги протокола без пары. Модель роняет их в поток отдельно от
 * вызова (или после уже разобранного), а открывающего маркера рядом нет —
 * значит, hold-буфер их не удержит и они утекут в чат как обычный текст.
 */
const STRAY_CLOSE_TAG_RE =
  /<\/(?:tool_call|function|parameter|tool_name|tool_arguments)>[ \t]*\n?/gi;
const STRAY_CLOSE_TAGS = [
  "</tool_call>",
  "</function>",
  "</parameter>",
  "</tool_name>",
  "</tool_arguments>",
];

function stripStrayCloseTags(text: string): string {
  if (!text || !text.includes("</")) return text;
  return text.replace(STRAY_CLOSE_TAG_RE, "");
}

/**
 * Длина хвоста, который выглядит началом закрывающего тега (`<`, `</`, `</too`…).
 * Такой хвост нельзя отдавать сразу: тег разорван границей чанка, и в чате его
 * половинки склеятся обратно в видимый `</tool_call>`.
 */
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
      .replace(/^\s*<tool_call>\s*$/gim, "")
      // Осиротевшие теги XML-протокола MiMo/Qwen-Coder: модель регулярно теряет
      // открывающий или закрывающий тег, и без этого они видны в чате.
      .replace(/<\/?tool_call>/gi, "")
      .replace(/<function\s*=\s*[\w.:-]+\s*>|<\/function>/gi, "")
      .replace(/<parameter\s*=\s*[\w.:-]+\s*>|<\/parameter>/gi, "")
      .replace(/<\/?tool_name>|<\/?tool_arguments>/gi, "")
      .trim()
  );
}

function sanitizeProtocolTranscript(text: string): string {
  if (!text) return "";

  let sanitized = text;
  sanitized = sanitized.replace(/```tool_call[\s\S]*?```/gi, "\n\n");
  sanitized = sanitized.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "\n\n");
  // Полный XML-вызов MiMo/Qwen-Coder (даже без обёртки <tool_call>).
  sanitized = sanitized.replace(
    /<function\s*=\s*[\w.:-]+\s*>[\s\S]*?<\/function>/gi,
    "\n\n",
  );
  // Пара <tool_name>…</tool_name><tool_arguments>…</tool_arguments>.
  sanitized = sanitized.replace(
    /<tool_name>[\s\S]*?<\/tool_name>(\s*<tool_arguments>[\s\S]*?<\/tool_arguments>)?/gi,
    "\n\n",
  );
  sanitized = stripInlineToolCallJson(sanitized);
  sanitized = sanitized.replace(/^\s*Assistant:\s?/gim, "");
  sanitized = sanitized.replace(/```[a-zA-Z0-9_-]*\s*\n\s*```/g, "\n");
  // Осиротевшие fence-маркеры (```), оставшиеся после вырезания tool_call JSON.
  // Применяется только к hold-региону tool_call, поэтому удаляем любые ``` —
  // иначе одиночный закрывающий фенс рендерится как пустой блок кода.
  sanitized = sanitized.replace(/```[a-zA-Z0-9_-]*/g, "");
  sanitized = sanitized.replace(/[ \t]{2,}/g, " ");
  sanitized = sanitized.replace(/\n{3,}/g, "\n\n");
  return sanitized;
}

/**
 * Маршрутизатор текстового потока в text/tool_call чанки.
 *
 * Web-модели (DeepSeek/Qwen/Kimi) не присылают нативные tool_calls — они
 * печатают вызов инструмента прямо в тексте (```tool_call ... ```). Этот класс
 * скользящим окном ловит начало маркера, придерживает потенциальный вызов до
 * конца стрима и затем парсит его в tool_call, не давая «протечь» сырому
 * протоколу в чат.
 *
 * Используется так:
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
    // null отключает транскрипт-страж (по умолчанию включён для всех провайдеров).
    private readonly cutPattern: RegExp | null = TRANSCRIPT_CUT_PATTERN,
    private readonly cutHoldback = TRANSCRIPT_CUT_HOLDBACK_CHARS,
  ) {}

  /**
   * true, если роутер сейчас придерживает потенциальный tool_call (виден маркер,
   * но вызов ещё не дописан). Нужно вызывающему, чтобы не обрывать стрим
   * преждевременно, пока формируется вызов.
   */
  get holding(): boolean {
    return this.holdActive;
  }

  /**
   * true, если в потоке распознана граница фейкового следующего хода и остаток
   * ответа отбрасывается. Вызывающему стоит остановить апстрим (reader.cancel),
   * чтобы модель не жгла токены на «доигрывание» диалога.
   */
  get cut(): boolean {
    return this.cutActive;
  }

  /**
   * Транскрипт-страж: ловит границу фейкового следующего хода, отдаёт текст до
   * неё и отбрасывает всё после. Holdback придерживает хвост, чтобы префикс
   * границы не утёк до распознавания. Безопасный текст уходит в routeSafe.
   */
  *route(rawText: string): Iterable<AIStreamChunk> {
    if (!rawText) {
      return;
    }
    if (this.cutActive) {
      return;
    }
    if (!this.cutPattern) {
      yield* this.routeSafe(rawText);
      return;
    }

    this.cutBuffer += rawText;
    const match = this.cutPattern.exec(this.cutBuffer);
    if (match) {
      this.cutActive = true;
      const safe = this.cutBuffer.slice(0, match.index).replace(/\s+$/, "");
      this.cutBuffer = "";
      if (safe) {
        yield* this.routeSafe(safe);
      }
      return;
    }

    const emitUpTo = Math.max(0, this.cutBuffer.length - this.cutHoldback);
    if (emitUpTo <= 0) {
      return;
    }
    const safe = this.cutBuffer.slice(0, emitUpTo);
    this.cutBuffer = this.cutBuffer.slice(emitUpTo);
    yield* this.routeSafe(safe);
  }

  /**
   * Единая точка выдачи текста: срезает осиротевшие закрывающие теги протокола.
   * Открывающего маркера у них нет, поэтому hold-буфер их не ловит, и без этой
   * очистки `</tool_call>` уходит прямо в чат.
   */
  private *emitText(text: string): Iterable<AIStreamChunk> {
    let content = stripStrayCloseTags(this.closeTagTail + text);
    this.closeTagTail = "";

    const partial = trailingCloseTagPrefixLen(content);
    if (partial > 0) {
      this.closeTagTail = content.slice(content.length - partial);
      content = content.slice(0, content.length - partial);
    }

    if (content) {
      yield { type: "text", content };
    }
  }

  /** Отдаёт недособранный хвост тега в конце ответа (полным тегом он уже не станет). */
  private *flushCloseTagTail(): Iterable<AIStreamChunk> {
    const tail = this.closeTagTail;
    this.closeTagTail = "";
    if (tail) {
      yield { type: "text", content: tail };
    }
  }

  private *routeSafe(rawText: string): Iterable<AIStreamChunk> {
    if (!rawText) {
      return;
    }

    if (!this.allowToolCalls) {
      yield* this.emitText(rawText);
      return;
    }

    if (this.holdActive) {
      this.holdBuffer += rawText;
      const realToolCall = looksLikeToolCallStart(this.holdBuffer);
      const overSoftLimit =
        this.holdBuffer.length >= MAX_TOOLCALL_HOLD_BUFFER_CHARS;
      const overHardCap =
        this.holdBuffer.length >= MAX_TOOLCALL_HARD_CAP_CHARS;
      if ((overSoftLimit && !realToolCall) || overHardCap) {
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
    } else if (this.pendingBuffer.length > TOOL_MARKER_HOLDBACK_CHARS) {
      yield* this.emitText(
        this.pendingBuffer.slice(
          0,
          this.pendingBuffer.length - TOOL_MARKER_HOLDBACK_CHARS,
        ),
      );
      this.pendingBuffer = this.pendingBuffer.slice(
        this.pendingBuffer.length - TOOL_MARKER_HOLDBACK_CHARS,
      );
    }
  }

  /**
   * Отдаёт удержанный holdback'ом хвост транскрипт-стража через routeSafe (если
   * границу так и не встретили). После обрыва (cutActive) буфер уже пуст.
   */
  private *flushCutTail(): Iterable<AIStreamChunk> {
    if (this.cutBuffer && !this.cutActive) {
      const tail = this.cutBuffer;
      this.cutBuffer = "";
      yield* this.routeSafe(tail);
    }
  }

  /** Сбрасывает остаток буфера: парсит tool_call либо отдаёт текст. */
  *finish(): Iterable<AIStreamChunk> {
    yield* this.flushCutTail();

    if (!this.allowToolCalls) {
      if (this.pendingBuffer) {
        const tail = this.pendingBuffer;
        this.pendingBuffer = "";
        yield* this.emitText(tail);
      }
      return;
    }

    const holdBuffer = this.holdActive ? this.holdBuffer : "";
    const tailText = this.holdActive ? "" : this.pendingBuffer;
    this.pendingBuffer = "";
    this.holdBuffer = "";
    this.holdActive = false;

    if (holdBuffer) {
      const parsedChunks = Array.from(
        parseToolCallsFromText(holdBuffer, {
          logger: this.logger,
          logPrefix: this.logPrefix,
        }),
      );
      const toolChunks = parsedChunks.filter((c) => c.type === "tool_call");
      const sanitizedRemainder = sanitizeProtocolTranscript(
        stripDanglingToolCallMarkers(holdBuffer),
      );

      if (toolChunks.length > 0) {
        for (const chunk of toolChunks) {
          yield chunk;
        }
        if (sanitizedRemainder.trim()) {
          yield* this.emitText(sanitizedRemainder);
        }
      } else {
        yield* this.emitText(sanitizedRemainder || holdBuffer.trim());
      }
    }

    if (tailText) {
      yield* this.emitText(tailText);
    }
    yield* this.flushCloseTagTail();
  }

  /**
   * Сбрасывает остаток буфера ТОЛЬКО как текст, без парсинга tool_call. Нужно,
   * когда вызовы инструментов уже получены другим каналом (нативные tool_calls),
   * и удержанный текст не должен превратиться в дублирующий вызов.
   */
  *finishAsText(): Iterable<AIStreamChunk> {
    yield* this.flushCutTail();

    const holdBuffer = this.holdActive ? this.holdBuffer : "";
    const tailText = this.holdActive ? "" : this.pendingBuffer;
    this.pendingBuffer = "";
    this.holdBuffer = "";
    this.holdActive = false;

    if (holdBuffer) {
      const sanitized = sanitizeProtocolTranscript(
        stripDanglingToolCallMarkers(holdBuffer),
      );
      yield* this.emitText(sanitized);
    }
    if (tailText) {
      yield* this.emitText(tailText);
    }
    yield* this.flushCloseTagTail();
  }
}
