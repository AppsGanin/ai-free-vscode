/**
 * Builds a flat text prompt from VS Code LM messages and tool definitions.
 * Browser-based APIs do not accept structured messages directly — this module
 * serialises the conversation into a single string.
 */

import { warn } from "./logger.mjs";

/**
 * Converts an array of OpenAI-compatible messages into a flat text prompt.
 *
 * @param {Array<{role: string, content: any, tool_calls?: any[], tool_call_id?: string}>} messages
 * @param {Array|null} tools  — tool definitions (for agent mode)
 * @param {number} maxChars   — trim conversation history to fit (0 = no limit)
 * @returns {string}
 */
export function messagesToPrompt(messages, tools, maxChars = 0) {
  const systemParts = [];
  const conversationParts = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n")
            : "";
      if (text) systemParts.push(text);
    } else if (m.role === "tool") {
      conversationParts.push(
        `User: [Tool result id=${m.tool_call_id}]\n${m.content}`,
      );
    } else {
      const role = m.role === "assistant" ? "Assistant" : "User";
      let content = "";
      if (typeof m.content === "string") content = m.content;
      else if (Array.isArray(m.content))
        content = m.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

      if (
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0
      ) {
        for (const tc of m.tool_calls) {
          let args = tc.function.arguments;
          try {
            args = JSON.stringify(JSON.parse(args), null, 2);
          } catch {}
          content += `\n\`\`\`tool_call\n{"name": "${tc.function.name}", "arguments": ${args}}\n\`\`\``;
        }
      }

      conversationParts.push(`${role}: ${content}`);
    }
  }

  if (tools && tools.length > 0) {
    const toolNames = tools.map((t) => t.function.name).join(", ");

    // Build concise per-tool usage hints for known VS Code Copilot tools
    const toolHints = tools
      .map((t) => {
        const name = t.function.name;
        const props = t.function.parameters?.properties ?? {};
        const required = t.function.parameters?.required ?? [];

        // Produce a compact example argument object
        const exampleArgs = {};
        for (const key of required) {
          const prop = props[key] ?? {};
          if (prop.type === "number" || prop.type === "integer") {
            exampleArgs[key] = prop.default ?? 1;
          } else if (prop.type === "boolean") {
            exampleArgs[key] = prop.default ?? false;
          } else {
            // Use enum first value, or a placeholder based on name/description
            exampleArgs[key] = prop.enum?.[0] ?? prop.example ?? `<${key}>`;
          }
        }

        const exampleJson = JSON.stringify(
          { name, arguments: exampleArgs },
          null,
          2,
        );
        return `// ${t.function.description ?? name}\n\`\`\`tool_call\n${exampleJson}\n\`\`\``;
      })
      .join("\n\n");

    systemParts.push(
      `## TOOLS

You have access to the following tools: ${toolNames}.
You MUST use them to answer questions about the codebase — do not refuse or claim you have no access to files.

### How to call a tool

Use ONLY this exact format — one call at a time:

\`\`\`tool_call
{"name": "tool_name", "arguments": {"param": "value"}}
\`\`\`

**STRICT rules for tool calls:**
- ALWAYS wrap every tool call in a \`\`\`tool_call\`\`\` block — NEVER output raw JSON outside a block.
- ALWAYS include ALL required parameters. Never omit any.
- If a previous call failed because a parameter was missing, fix it by providing ALL parameters in ONE complete new call.
- Do NOT repeat the same broken call. Do NOT output JSON outside a fence block as a retry.
- NEVER place tool_call blocks inside thinking/reasoning text. Thinking must be plain natural language only.

### Tool call examples (one per tool)

${toolHints}

### Agent workflow rules

- Call tools ONE AT A TIME. Wait for each result before calling the next.
- **IMPORTANT**: If you need to call a tool, output the tool call IMMEDIATELY in this same response — do NOT say "I'll now do X" and stop. Always follow any intro text with the actual tool call in the same response turn.
- Use \`list_dir\` / \`file_search\` to discover files before reading them.
- Use \`read_file\` with reasonable line ranges — prefer 50–200 lines per call.
- Use \`grep_search\` or \`semantic_search\` to locate relevant code quickly.
- Use \`run_in_terminal\` to run tests, builds, or shell commands when needed.
- Use \`replace_string_in_file\` (not terminal) to edit existing files.
- Use \`create_file\` only for new files that do not yet exist.
- When the task is complete, give a clear final answer WITHOUT any tool calls.
- The JSON in a tool_call block must be valid — no comments, no trailing commas.

Available tool schemas (JSON):
${JSON.stringify(tools, null, 2)}`,
    );
  }

  let systemBlock = "";
  if (systemParts.length > 0) {
    systemBlock = `System: ${systemParts.join("\n\n")}\n\n`;
  }
  const suffix = "\n\nAssistant:";

  // Trim conversation history to fit within the limit (when maxChars > 0).
  // Always keep the last part (current user message); drop from the front.
  const budget =
    maxChars > 0 ? maxChars - systemBlock.length - suffix.length : Infinity;
  let trimmedParts = conversationParts;
  if (budget !== Infinity) {
    if (budget <= 0) {
      // System block alone already exceeds the limit — keep only the last
      // conversation part (current user message) and hope for the best.
      warn(
        `[PROMPT_TRIMMED] System block (${systemBlock.length} chars) already exceeds limit of ${maxChars}. Keeping only last conversation part.`,
      );
      trimmedParts = conversationParts.slice(-1);
    } else {
      // Walk from the end, accumulating parts until budget is exhausted
      let total = 0;
      let start = conversationParts.length;
      for (let i = conversationParts.length - 1; i >= 0; i--) {
        const add = conversationParts[i].length + (i > 0 ? 2 : 0); // +2 for "\n\n" separator
        if (total + add > budget && i < conversationParts.length - 1) break;
        total += add;
        start = i;
      }
      if (start > 0) {
        warn(
          `[PROMPT_TRIMMED] Dropped ${start} oldest conversation part(s) to fit within ${maxChars} char limit`,
        );
        trimmedParts = conversationParts.slice(start);
      }
    }
  }

  return systemBlock + trimmedParts.join("\n\n") + suffix;
}
