import * as vscode from "vscode";
import { log } from "../logger";
import type {
  AIMessage,
  AIMessageContentPart,
  AIToolCall,
  AIToolResult,
} from "../providers/types";

// ─── VS Code message conversion ─────────────────────────────────────────────

export interface MessageConversionOptions {
  /**
   * How tool calls and tool results are carried.
   *
   * `false` (default) inlines them into the text — the web backends have no
   * tool protocol of their own and only ever see a flat transcript.
   * `true` keeps them structured in `toolCalls` / `toolResults`, for backends
   * that speak the OpenAI tools API natively.
   */
  nativeTools?: boolean;
}

/** Converts a VS Code chat message into our provider-neutral shape. */
export function vsCodeMessageToAI(
  msg: vscode.LanguageModelChatRequestMessage,
  opts: MessageConversionOptions = {},
): AIMessage {
  const native = opts.nativeTools === true;
  const toolCalls: AIToolCall[] = [];
  const toolResults: AIToolResult[] = [];
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
      if (native) {
        toolCalls.push({
          id: part.callId,
          name: part.name,
          arguments: stringify(part.input ?? {}),
        });
      } else {
        appendText(
          "```tool_call\n" +
            JSON.stringify(
              { name: part.name, arguments: part.input ?? {} },
              null,
              2,
            ) +
            "\n```",
        );
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      const content = concatToolResultContent(part.content ?? []);
      if (native) {
        toolResults.push({ callId: part.callId, content });
      } else {
        appendText(`[Tool result id=${part.callId}]\n${content}`);
      }
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

  const structured = {
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
  };

  if (imageSources.length === 0) {
    return {
      role,
      content: parts.map((p) => (p.type === "text" ? p.text : "")).join(""),
      ...structured,
    };
  }

  log(
    `[types] image parts parsed role=${role} count=${imageSources.length} sources=${imageSources.slice(0, 4).join(", ")}`,
  );
  return { role, content: parts, ...structured };
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
