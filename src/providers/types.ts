import * as vscode from "vscode";
import { log } from "../logger";

// ─── Models ─────────────────────────────────────────────────────────────────

export interface AIModelCapabilities {
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  /** Fit for inline suggestions; `false` hides it from that picker. */
  suggestions?: boolean;
  /** Fit for commit messages; `false` hides it from that picker. */
  commit?: boolean;
  /** Fit for "Fix with AI Free"; `false` hides it from that picker. */
  fix?: boolean;
  /**
   * Fit for chat. `false` drops the model from the VS Code list entirely — and
   * therefore from the other features, which read that same list.
   */
  chat?: boolean;
}

export interface AIModelInfo {
  id: string;
  name: string;
  /** Model family, used for grouping in the picker. */
  family: string;
  version?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: AIModelCapabilities;
}

// ─── Request / response ─────────────────────────────────────────────────────

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
  model: string;
  messages: AIMessage[];
  /** Upstream chat/session id, to keep context across turns. */
  chatId?: string;
  /** Parent message id, for backends that chain messages. */
  parentId?: string;
  tools?: AIToolDefinition[];
  toolMode?: "auto" | "required" | "none";
  /**
   * Forced thinking mode, overriding the provider default. Service requests
   * (commits, inline suggestions) turn it off — reasoning only adds latency.
   */
  thinkingMode?: "auto" | "on" | "off";
  abortSignal?: AbortSignal;
}

// ─── Stream chunks ──────────────────────────────────────────────────────────

export type AIStreamChunk =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      /** JSON arguments; may arrive in pieces. */
      argumentsPart: string;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number };

// ─── Errors ─────────────────────────────────────────────────────────────────

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
 * Aliyun WAF turned the direct server request away, answering with an HTML
 * challenge (usually at status 200) instead of an SSE stream. Signals that the
 * browser path should be used.
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

// ─── VS Code message conversion ─────────────────────────────────────────────

/** Converts a VS Code chat message into our provider-neutral shape. */
export function vsCodeMessageToAI(
  msg: vscode.LanguageModelChatRequestMessage,
): AIMessage {
  // The provider API only defines user/assistant. Anything else is kept as
  // assistant rather than promoted to system, to avoid bloating the prompt.
  const role: AIMessage["role"] =
    msg.role === vscode.LanguageModelChatMessageRole.User
      ? "user"
      : "assistant";

  const parts: AIMessageContentPart[] = [];
  const imageSources: string[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === "text") last.text += text;
    else parts.push({ type: "text", text });
  };

  const appendImage = (url: string) => {
    if (!url) return;
    parts.push({ type: "image_url", imageUrl: { url } });
    imageSources.push(describeImageSource(url));
  };

  for (const part of msg.content) {
    if (typeof part === "string") {
      appendText(part);
      continue;
    }

    if (part instanceof vscode.LanguageModelDataPart) {
      const dataUrl = toImageDataUrl(part);
      // Non-images are serialized to text so the context is not lost.
      if (dataUrl) appendImage(dataUrl);
      else appendText(Buffer.from(part.data).toString("utf-8"));
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      appendText(
        "```tool_call\n" +
          JSON.stringify(
            { name: part.name, arguments: part.input ?? {} },
            null,
            2,
          ) +
          "\n```",
      );
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      appendText(
        `[Tool result id=${part.callId}]\n${concatToolResultContent(part.content ?? [])}`,
      );
      continue;
    }

    const imageUrl = extractImageUrl(part);
    if (imageUrl) {
      appendImage(imageUrl);
      continue;
    }

    // LanguageModelTextPart and anything else structured.
    const value =
      part && typeof part === "object" && "value" in part
        ? (part as { value?: unknown }).value
        : part;
    if (typeof value === "string") {
      appendText(value);
    } else if (value !== undefined && value !== null) {
      const nested = extractImageUrl(value);
      if (nested) appendImage(nested);
      else appendText(stringify(value));
    }
  }

  if (imageSources.length === 0) {
    return {
      role,
      content: parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
    };
  }

  log(
    `[types] image parts parsed role=${role} count=${imageSources.length} sources=${imageSources.slice(0, 4).join(", ")}`,
  );
  return { role, content: parts };
}

function describeImageSource(url: string): string {
  const raw = url.trim().toLowerCase();
  if (raw.startsWith("data:")) return `data:${raw.slice(5).split(";")[0]}`;
  const scheme = /^(https?|file|blob):/.exec(raw)?.[1];
  return scheme ?? "other";
}

function toImageDataUrl(
  part: vscode.LanguageModelDataPart,
): string | undefined {
  const mime = String(part.mimeType ?? "")
    .trim()
    .toLowerCase();
  if (!mime.startsWith("image/")) return undefined;
  const base64 = Buffer.from(part.data).toString("base64");
  return base64 ? `data:${mime};base64,${base64}` : undefined;
}

/** Finds an image URL in an unknown part shape (`url`, `imageUrl.url`, `value`). */
function extractImageUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  const direct = obj.url;
  if (typeof direct === "string" && looksLikeImageUrl(direct)) return direct;

  const nested = (obj.imageUrl as { url?: unknown } | undefined)?.url;
  if (typeof nested === "string" && looksLikeImageUrl(nested)) return nested;

  return obj.value ? extractImageUrl(obj.value) : undefined;
}

function looksLikeImageUrl(url: string): boolean {
  const raw = url.trim();
  return (
    /^(https?:|file:|data:|blob:)/i.test(raw) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(raw)
  );
}

function concatToolResultContent(parts: readonly unknown[]): string {
  let text = "";

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      text += `[data:${part.mimeType};base64,${Buffer.from(part.data).toString("base64")}]`;
    } else if (typeof part === "string") {
      text += part;
    } else if (part && typeof part === "object" && "value" in part) {
      const value = (part as { value?: unknown }).value;
      if (value !== undefined) {
        text += typeof value === "string" ? value : stringify(value);
      }
    } else if (part !== null && part !== undefined) {
      text += stringify(part);
    }
  }

  return text.trim() || "{}";
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
