import * as vscode from "vscode";
import { log } from "../logger";

// ─── Model Info ────────────────────────────────────────────────────────────────

export interface AIModelCapabilities {
  /** Поддержка вызова инструментов (function calling) */
  toolCalling?: boolean;
  /** Поддержка изображений как входных данных */
  imageInput?: boolean;
  /** Поддержка thinking-режима */
  thinking?: boolean;
  /** Годится для inline-подсказок. `false` убирает её из выбора. */
  suggestions?: boolean;
  /** Годится для генерации коммит-сообщений. `false` убирает её из выбора. */
  commit?: boolean;
  /** Годится для «Fix with AI». `false` убирает её из выбора. */
  fix?: boolean;
  /**
   * Годится для чата. `false` убирает модель из списка VS Code целиком —
   * а значит и из остальных фич, они берут модели оттуда же.
   */
  chat?: boolean;
  /** Поддержка потокового режима */
  streaming?: boolean;
}

export interface AIModelInfo {
  /** Уникальный идентификатор модели у данного провайдера */
  id: string;
  /** Отображаемое имя */
  name: string;
  /** Семейство модели (для группировки в пикере) */
  family: string;
  /** Версия модели */
  version?: string;
  /** Максимальный контекст (токены входа) */
  maxInputTokens: number;
  /** Максимальное количество токенов ответа */
  maxOutputTokens: number;
  /** Возможности модели */
  capabilities: AIModelCapabilities;
}

// ─── Request / Response ────────────────────────────────────────────────────────

export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string | AIMessageContentPart[];
}

export type AIMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string } };

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIRequestParams {
  /** ID модели провайдера */
  model: string;
  /** Массив сообщений */
  messages: AIMessage[];
  /** ID чата для сохранения контекста (опционально) */
  chatId?: string;
  /** ID родительского сообщения для цепочки контекста */
  parentId?: string;
  /** Список доступных инструментов */
  tools?: AIToolDefinition[];
  /** Режим вызова tools */
  toolMode?: "auto" | "required" | "none";
  /**
   * Принудительный режим thinking. Переопределяет настройку провайдера.
   * Используется для служебных запросов (коммиты, inline-подсказки), где
   * reasoning не нужен и только добавляет задержку.
   */
  thinkingMode?: "auto" | "on" | "off";
  /** AbortSignal для отмены запроса */
  abortSignal?: AbortSignal;
}

// ─── Stream Chunks ─────────────────────────────────────────────────────────────

export interface AITextChunk {
  type: "text";
  content: string;
}

export interface AIThinkingChunk {
  type: "thinking";
  content: string;
}

export interface AIToolCallChunk {
  type: "tool_call";
  callId: string;
  name: string;
  /** JSON-строка аргументов (может приходить по частям) */
  argumentsPart: string;
}

export interface AIUsageChunk {
  type: "usage";
  promptTokens: number;
  completionTokens: number;
}

export type AIStreamChunk =
  | AITextChunk
  | AIThinkingChunk
  | AIToolCallChunk
  | AIUsageChunk;

// ─── Errors ────────────────────────────────────────────────────────────────────

export class AuthExpiredError extends Error {
  constructor(public readonly providerId: string) {
    super(`Authentication expired for provider: ${providerId}`);
    this.name = "AuthExpiredError";
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Rate limit exceeded for provider: ${providerId}`);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Aliyun WAF завернул прямой серверный запрос: вернулся HTML-челлендж
 * (обычно со статусом 200) вместо SSE-потока. Сигнал перейти на браузерный путь.
 */
export class WafChallengeError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "WafChallengeError";
  }
}

// ─── VS Code message conversion helpers ───────────────────────────────────────

/**
 * Конвертирует vscode.LanguageModelChatMessage в AIMessage.
 * Используется в VSCodeLMAdapter.
 */
export function vsCodeMessageToAI(
  msg: vscode.LanguageModelChatRequestMessage,
): AIMessage {
  let role: AIMessage["role"];
  switch (msg.role) {
    case vscode.LanguageModelChatMessageRole.User:
      role = "user";
      break;
    case vscode.LanguageModelChatMessageRole.Assistant:
      role = "assistant";
      break;
    default:
      // В API VS Code provider role официально user/assistant.
      // Нестандартные роли не отправляем как system, чтобы не раздувать prompt.
      role = "assistant";
      break;
  }

  // Собираем части сообщения, сохраняя изображения как отдельные image_url-part.
  const contentParts: AIMessageContentPart[] = [];
  const imageSources: string[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const last = contentParts[contentParts.length - 1];
    if (last && last.type === "text") {
      last.text += text;
      return;
    }
    contentParts.push({ type: "text", text });
  };

  const appendImageUrl = (url: string) => {
    if (!url) return;
    contentParts.push({ type: "image_url", imageUrl: { url } });
  };

  for (const part of msg.content) {
    if (typeof part === "string") {
      appendText(part);
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const imageDataUrl = toImageDataUrl(part);
      if (imageDataUrl) {
        appendImageUrl(imageDataUrl);
        imageSources.push(`data:${part.mimeType}`);
        continue;
      }

      // Не-изображения сериализуем в текст, чтобы не терять контекст.
      const raw = Buffer.from(part.data).toString("utf-8");
      appendText(raw);
      continue;
    }

    const imageUrl = extractImageUrlFromUnknown(part);
    if (imageUrl) {
      appendImageUrl(imageUrl);
      imageSources.push(describeImageUrlSource(imageUrl));
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      const args = part.input ?? {};
      appendText(
        "```tool_call\n" +
          JSON.stringify({ name: part.name, arguments: args }, null, 2) +
          "\n```",
      );
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      const resultText = concatToolResultContent(part.content ?? []);
      appendText(`[Tool result id=${part.callId}]\n${resultText}`);
      continue;
    }

    // LanguageModelTextPart
    if (
      typeof part === "object" &&
      part !== null &&
      "value" in (part as Record<string, unknown>) &&
      "value" in (part as { value?: unknown })
    ) {
      const value = (part as { value?: unknown }).value;
      if (typeof value === "string") {
        appendText(value);
      } else if (value !== undefined) {
        const nestedImageUrl = extractImageUrlFromUnknown(value);
        if (nestedImageUrl) {
          appendImageUrl(nestedImageUrl);
          imageSources.push(describeImageUrlSource(nestedImageUrl));
          continue;
        }
        try {
          appendText(JSON.stringify(value));
        } catch {
          appendText(String(value));
        }
      }
      continue;
    }

    // Fallback: не теряем нестандартные части (например tool result/meta)
    if (typeof part === "object" && part !== null) {
      try {
        appendText(JSON.stringify(part));
      } catch {
        appendText(String(part));
      }
    }
  }

  const hasImages = contentParts.some((p) => p.type === "image_url");
  if (!hasImages) {
    const text = contentParts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    return { role, content: text };
  }

  const preview = imageSources.slice(0, 4).join(", ");
  log(
    `[types] image parts parsed role=${role} count=${imageSources.length} sources=${preview}`,
  );

  return { role, content: contentParts };
}

function describeImageUrlSource(url: string): string {
  const raw = url.trim().toLowerCase();
  if (raw.startsWith("data:")) {
    const mime = raw.slice(5).split(";")[0] ?? "unknown";
    return `data:${mime}`;
  }
  if (raw.startsWith("https://")) return "https";
  if (raw.startsWith("http://")) return "http";
  if (raw.startsWith("file:")) return "file";
  if (raw.startsWith("blob:")) return "blob";
  return "other";
}

function extractImageUrlFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const obj = value as Record<string, unknown>;

  const directUrl = obj.url;
  if (typeof directUrl === "string" && looksLikeImageUrl(directUrl)) {
    return directUrl;
  }

  const imageUrlObj = obj.imageUrl;
  if (imageUrlObj && typeof imageUrlObj === "object") {
    const nestedUrl = (imageUrlObj as { url?: unknown }).url;
    if (typeof nestedUrl === "string" && looksLikeImageUrl(nestedUrl)) {
      return nestedUrl;
    }
  }

  const valueObj = obj.value;
  if (valueObj && typeof valueObj === "object") {
    const nestedUrl = extractImageUrlFromUnknown(valueObj);
    if (nestedUrl) {
      return nestedUrl;
    }
  }

  return undefined;
}

function toImageDataUrl(
  part: vscode.LanguageModelDataPart,
): string | undefined {
  const mime = String(part.mimeType ?? "")
    .trim()
    .toLowerCase();
  if (!mime.startsWith("image/")) {
    return undefined;
  }
  const b64 = Buffer.from(part.data).toString("base64");
  if (!b64) {
    return undefined;
  }
  return `data:${mime};base64,${b64}`;
}

function looksLikeImageUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw) return false;

  if (/^(https?:|file:|data:|blob:)/i.test(raw)) {
    return true;
  }

  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(raw)) {
    return true;
  }

  return false;
}

function concatToolResultContent(parts: readonly unknown[]): string {
  let text = "";
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
      continue;
    }
    if (part instanceof vscode.LanguageModelDataPart) {
      const b64 = Buffer.from(part.data).toString("base64");
      text += `[data:${part.mimeType};base64,${b64}]`;
      continue;
    }
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (part && typeof part === "object" && "value" in part) {
      const value = (part as { value?: unknown }).value;
      if (typeof value === "string") {
        text += value;
      } else if (value !== undefined) {
        try {
          text += JSON.stringify(value);
        } catch {
          text += String(value);
        }
      }
      continue;
    }
    if (part !== null && part !== undefined) {
      try {
        text += JSON.stringify(part);
      } catch {
        text += String(part);
      }
    }
  }
  const normalized = text.trim();
  return normalized.length > 0 ? normalized : "{}";
}
