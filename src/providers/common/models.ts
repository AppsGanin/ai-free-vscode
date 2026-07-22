import type { AIModelInfo } from "../types";

/** Case-insensitive `alias → canonical id` lookup; unknown ids pass through. */
export function aliasResolver(
  aliases: Record<string, string>,
): (id: string) => string {
  const map = new Map(
    Object.entries(aliases).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return (id: string) => map.get(id.toLowerCase()) ?? id;
}

/**
 * Thinking stays off whenever tools are in play: reasoning + tool calls is
 * unreliable on these web backends (the call leaks into the reasoning channel).
 * `off` comes from service requests — commits, fixes, inline suggestions.
 */
export function thinkingEnabled(
  models: readonly AIModelInfo[],
  modelId: string,
  hasTools: boolean,
  override?: "auto" | "on" | "off",
): boolean {
  if (hasTools || override === "off") {
    return false;
  }
  const id = modelId.toLowerCase();
  return Boolean(
    models.find((m) => m.id.toLowerCase() === id)?.capabilities.thinking,
  );
}
