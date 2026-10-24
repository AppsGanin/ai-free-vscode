import type { ContentBlock, RequestMessage } from "@deepseek-ai/dsh-llm";
import type { AIMessage } from "../../src/providers/types";

/**
 * Harness messages → our provider-neutral transcript.
 *
 * The web backends have no tool protocol of their own, so tool calls and
 * results are written into the text in exactly the shape the VS Code side
 * uses (src/vscode/messages.ts): the prompt protocol, the parsers and the
 * transcript-echo scrubbing all expect these markers.
 */
export function toAIMessages(messages: readonly RequestMessage[], system?: string): AIMessage[] {
  const out: AIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    switch (message.role) {
      case "system":
      // Developer messages carry the harness's own instructions and context
      // notices; the providers fold system text into their system slot.
      case "developer": {
        const text = textOf(message.content);
        if (text) out.push({ role: "system", content: text });
        break;
      }
      case "user": {
        const text = textOf(message.content);
        if (text) out.push({ role: "user", content: text });
        break;
      }
      case "assistant": {
        const parts: string[] = [];
        for (const block of message.content) {
          if (block.type === "text" && block.text) parts.push(block.text);
          else if (block.type === "tool-call") parts.push(toolCallText(block.name, block.arguments));
          // Reasoning stays out: the backends never see their own thoughts back.
        }
        if (parts.length > 0) out.push({ role: "assistant", content: parts.join("\n\n") });
        break;
      }
      case "tool": {
        const result = `[Tool result id=${message.toolCallId}]\n${textOf(message.content)}`;
        // A turn's results go back as one user message, as VS Code sends them.
        const last = out[out.length - 1];
        if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[Tool result id=")) {
          last.content += `\n\n${result}`;
        } else {
          out.push({ role: "user", content: result });
        }
        break;
      }
    }
  }
  return out;
}

function toolCallText(name: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || "{}");
  } catch {
    parsed = args;
  }
  return "```tool_call\n" + JSON.stringify({ name, arguments: parsed ?? {} }, null, 2) + "\n```";
}

/** Text of a message; attachments are named, since these backends cannot take them. */
function textOf(content: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[image omitted: not supported by this provider]");
    else if (block.type === "file") parts.push("[file omitted: not supported by this provider]");
  }
  return parts.filter(Boolean).join("\n");
}
