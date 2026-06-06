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

export function stripDanglingToolCallMarkers(text: string): string {
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
  sanitized = sanitized.replace(/```tool_call[\s\S]*?```/gi, "\n\n");
  sanitized = sanitized.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "\n\n");
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

  private *routeSafe(rawText: string): Iterable<AIStreamChunk> {
    if (!rawText) {
      return;
    }

    if (!this.allowToolCalls) {
      yield { type: "text", content: rawText };
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
        const sanitized = stripDanglingToolCallMarkers(this.holdBuffer);
        if (sanitized) {
          yield { type: "text", content: sanitized };
        }
        this.holdBuffer = "";
        this.holdActive = false;
      }
      return;
    }

    this.pendingBuffer += rawText;
    const markerIdx = findToolCallMarkerStart(this.pendingBuffer);

    if (markerIdx !== -1) {
      const safeText = this.pendingBuffer.slice(0, markerIdx);
      if (safeText) {
        yield { type: "text", content: safeText };
      }
      this.holdBuffer = this.pendingBuffer.slice(markerIdx);
      this.pendingBuffer = "";
      this.holdActive = true;
    } else if (this.pendingBuffer.length > TOOL_MARKER_HOLDBACK_CHARS) {
      const safeText = this.pendingBuffer.slice(
        0,
        this.pendingBuffer.length - TOOL_MARKER_HOLDBACK_CHARS,
      );
      if (safeText) {
        yield { type: "text", content: safeText };
      }
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
        yield { type: "text", content: this.pendingBuffer };
        this.pendingBuffer = "";
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
          yield { type: "text", content: sanitizedRemainder };
        }
      } else {
        const textOut = sanitizedRemainder || holdBuffer.trim();
        if (textOut) {
          yield { type: "text", content: textOut };
        }
      }
    }

    if (tailText) {
      yield { type: "text", content: tailText };
    }
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
      if (sanitized) {
        yield { type: "text", content: sanitized };
      }
    }
    if (tailText) {
      yield { type: "text", content: tailText };
    }
  }
}
