import type { AIMessage, AIRequestParams } from "../types";

/** Web models drift to English without this; every provider prepends it. */
export const LANGUAGE_GUARD =
  "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";

/**
 * BPE gives roughly 4 characters per token for latin text and only ~1.5 for
 * Cyrillic/CJK, where most characters cost a token or more on their own.
 */
const LATIN_CHARS_PER_TOKEN = 4;
const WIDE_CHARS_PER_TOKEN = 1.5;

/** Rough but honest token count: `length / 4` badly underestimates non-latin. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
  }
  return Math.ceil(
    ascii / LATIN_CHARS_PER_TOKEN +
      (text.length - ascii) / WIDE_CHARS_PER_TOKEN,
  );
}

/**
 * Characters that fit into `maxTokens` for *this* conversation.
 *
 * The prompt is capped by characters, but the upstream limit is in tokens, and
 * the exchange rate between the two is a property of the text: a Russian chat
 * costs about twice the tokens per character of an English one. A single char
 * ceiling therefore either wastes most of the window or overruns it — the
 * latter surfacing as "Content is too long" on every second turn.
 */
export function charBudgetForTokens(
  messages: AIMessage[],
  maxTokens: number,
): number {
  let chars = 0;
  let tokens = 0;

  for (const message of messages) {
    if (message.role === "system") continue;
    const text = contentToString(message.content);
    chars += text.length;
    tokens += estimateTokens(text);
  }

  // Nothing to measure yet — assume latin, the cheaper of the two.
  if (tokens === 0) return maxTokens * LATIN_CHARS_PER_TOKEN;
  return Math.floor(maxTokens * (chars / tokens));
}

export function contentToString(content: AIMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

/**
 * How much of the conversation a prompt may carry.
 *
 * `maxTokens` is the one to reach for: it is what the upstream actually limits,
 * and it is converted per conversation by `charBudgetForTokens`. `maxChars` is
 * an explicit override for probing an unknown window down step by step, and
 * wins when both are given.
 */
export interface PromptBudget {
  maxChars?: number;
  maxTokens?: number;
}

function budgetChars(
  messages: AIMessage[],
  budget: PromptBudget,
): number | undefined {
  if (budget.maxChars !== undefined) return budget.maxChars;
  if (budget.maxTokens !== undefined) {
    return charBudgetForTokens(messages, budget.maxTokens);
  }
  return undefined;
}

/**
 * Kimi/MiMo accept a single user turn, so the whole conversation is flattened
 * into `role:text` lines; the tools protocol goes last.
 */
export function buildFlatTranscript(
  messages: AIMessage[],
  toolsPrompt = "",
  budget: PromptBudget = {},
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

  const systemLine = `system:${[LANGUAGE_GUARD, ...systems].join("\n")}`;
  const maxChars = budgetChars(messages, budget);
  // The system line and the tools protocol are outside the cap: neither may be
  // truncated, so the turns are what gives way.
  const kept = maxChars
    ? keepNewest(turns, maxChars, { reserved: systemLine.length, join: 1 })
    : turns;

  const body = [systemLine, ...kept].join("\n");
  return toolsPrompt ? `${body.trim()}\n\n${toolsPrompt}` : body;
}

/** Qwen/DeepSeek: `Role: text` blocks ending with an open `Assistant:` turn. */
export function buildRolePrompt(
  messages: AIMessage[],
  opts: { system?: string } & PromptBudget = {},
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

  const maxChars = budgetChars(messages, opts);
  const kept = maxChars
    ? keepNewest(parts, maxChars, {
        reserved: "\n\nAssistant:".length,
        join: 2,
      })
    : parts;
  if (opts.system) {
    kept.unshift(`System: ${opts.system}`);
  }
  return [...kept, "Assistant:"].join("\n\n");
}

/** Drops the oldest turns until the prompt fits; truncates a lone huge turn. */
function keepNewest(
  parts: string[],
  maxChars: number,
  frame: { reserved: number; join: number },
): string[] {
  const kept: string[] = [];
  let total = frame.reserved;

  for (let i = parts.length - 1; i >= 0; i--) {
    const addition = parts[i].length + (kept.length > 0 ? frame.join : 0);
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
