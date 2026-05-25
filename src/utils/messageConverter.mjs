/**
 * Converts VS Code LanguageModelChatMessage[] into OpenAI-compatible message
 * objects consumed by messagesToPrompt().
 *
 * Handles:
 *  - Regular user / assistant text messages
 *  - Tool call parts in assistant messages
 *  - Tool result parts in user messages (including binary LanguageModelDataPart)
 */

import * as vscode from "vscode";

/**
 * Converts LanguageModelChatMessage[] → OpenAI-compatible message array.
 *
 * @param {readonly vscode.LanguageModelChatRequestMessage[]} messages
 * @returns {Array<{role: string, content: any, tool_calls?: any[], tool_call_id?: string}>}
 */
export function convertMessages(messages) {
  return messages
    .map((msg) => {
      const isAssistant =
        msg.role === vscode.LanguageModelChatMessageRole.Assistant;
      const role = isAssistant ? "assistant" : "user";

      const content = (msg.content ?? [])
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) return part.value;
          if (typeof part === "string") return part;
          return "";
        })
        .join("");

      // Collect tool calls from assistant message
      const toolCallParts = (msg.content ?? []).filter(
        (p) => p instanceof vscode.LanguageModelToolCallPart,
      );
      const toolCalls = toolCallParts.map((p) => ({
        id: p.callId,
        type: "function",
        function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
      }));

      // Collect tool results from user message
      const toolResultParts = (msg.content ?? []).filter(
        (p) => p instanceof vscode.LanguageModelToolResultPart,
      );

      if (toolResultParts.length > 0) {
        // Each tool result → separate message with role="tool"
        return toolResultParts.map((p) => ({
          role: "tool",
          tool_call_id: p.callId,
          content: concatToolResultContent(p.content ?? []),
        }));
      }

      const result = { role, content };
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
      return result;
    })
    .flat();
}

/**
 * Serialises tool result content parts to a plain string.
 *
 * Handles:
 *  - LanguageModelTextPart → raw text
 *  - LanguageModelDataPart → data-URI (so the model can at least log it)
 *  - Duck-typed {value: string} objects → text
 *  - Anything else → JSON.stringify / String()
 *
 * Returns "{}" for empty results so the model always receives a valid token.
 *
 * @param {readonly unknown[]} parts
 * @returns {string}
 */
export function concatToolResultContent(parts) {
  let text = "";
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      const b64 = Buffer.from(part.data).toString("base64");
      text += `[data:${part.mimeType};base64,${b64}]`;
    } else if (
      part &&
      typeof part === "object" &&
      "value" in part &&
      typeof part.value === "string"
    ) {
      text += part.value;
    } else if (part !== null && part !== undefined) {
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
