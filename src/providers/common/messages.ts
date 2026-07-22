import type { AIMessage, AIRequestParams } from "../types";

/** Web models drift to English without this; every provider prepends it. */
export const LANGUAGE_GUARD =
  "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";

export function contentToString(content: AIMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

/**
 * Kimi/MiMo accept a single user turn, so the whole conversation is flattened
 * into `role:text` lines; the tools protocol goes last.
 */
export function buildFlatTranscript(
  messages: AIMessage[],
  toolsPrompt = "",
): string {
  const systems: string[] = [];
  const turns: string[] = [];

  for (const msg of messages) {
    const content = contentToString(msg.content).trim();
    if (!content) continue;
    if (msg.role === "system") {
      systems.push(content);
      continue;
    }
    turns.push(`${msg.role === "assistant" ? "assistant" : "user"}:${content}`);
  }

  const body = [
    `system:${[LANGUAGE_GUARD, ...systems].join("\n")}`,
    ...turns,
  ].join("\n");

  return toolsPrompt ? `${body.trim()}\n\n${toolsPrompt}` : body;
}

/** Qwen/DeepSeek: `Role: text` blocks ending with an open `Assistant:` turn. */
export function buildRolePrompt(
  messages: AIMessage[],
  opts: { system?: string; maxChars?: number } = {},
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;
    const content = contentToString(msg.content).trim();
    if (!content) continue;
    parts.push(
      `${msg.role === "assistant" ? "Assistant" : "User"}: ${content}`,
    );
  }

  const kept = opts.maxChars ? keepNewest(parts, opts.maxChars) : parts;
  if (opts.system) {
    kept.unshift(`System: ${opts.system}`);
  }
  return [...kept, "Assistant:"].join("\n\n");
}

/** Drops the oldest turns until the prompt fits; truncates a lone huge turn. */
function keepNewest(parts: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let total = "\n\nAssistant:".length;

  for (let i = parts.length - 1; i >= 0; i--) {
    const addition = parts[i].length + (kept.length > 0 ? 2 : 0);
    if (total + addition > maxChars) {
      if (kept.length === 0) {
        const available = Math.max(128, maxChars - total);
        kept.unshift(parts[i].slice(-available));
      }
      break;
    }
    kept.unshift(parts[i]);
    total += addition;
  }

  return kept;
}

/**
 * Stable key for the upstream chat/session cache: same model + same opening
 * user message means the same conversation.
 */
export function conversationKey(params: AIRequestParams): string {
  const first = params.messages.find((m) => m.role === "user");
  const basis = `${params.model}::${
    first ? contentToString(first.content).slice(0, 600) : ""
  }`;

  let hash = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
