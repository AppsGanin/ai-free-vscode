/**
 * Utilities for building prompts and parsing tool calls.
 * Used by the LM provider.
 */

/**
 * Converts an array of OpenAI-compatible messages into a flat text prompt
 * for browser-based APIs (which do not accept structured messages directly).
 *
 * @param {Array<{role: string, content: any, tool_calls?: any[], tool_call_id?: string}>} messages
 * @param {Array|null} tools  — tool definitions (for agent mode)
 * @returns {string}
 */
export function messagesToPrompt(messages, tools) {
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
    systemParts.push(
      `## TOOLS

You have access to the following tools: ${toolNames}.
You MUST use them — do not refuse or claim you have no access to files.

When you need to call a tool, you MUST use ONLY this exact format:

\`\`\`tool_call
{"name": "tool_name", "arguments": {"param": "value"}}
\`\`\`

Example — read file src/index.ts:
\`\`\`tool_call
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
\`\`\`

IMPORTANT:
- ONLY use the \`\`\`tool_call fence format above. No other formats.
- The block must contain valid JSON — no comments, no // lines.
- Call tools one at a time. After receiving the result, continue solving the task.
- When the task is done — give a final answer without tool calls.

Available tools (JSON schemas):
${JSON.stringify(tools, null, 2)}`,
    );
  }

  let prompt = "";
  if (systemParts.length > 0) {
    prompt = `System: ${systemParts.join("\n\n")}\n\n`;
  }
  prompt += conversationParts.join("\n\n") + "\n\nAssistant:";
  return prompt;
}

/**
 * Extracts tool calls from model response text.
 * Format: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *
 * @param {string} text
 * @returns {Array<{id: string, type: "function", function: {name: string, arguments: string}}>}
 */
/**
 * Repairs model-generated JSON:
 * - strips // and /* comments ONLY outside string values
 * - escapes real newlines inside string values
 */
function repairJson(raw) {
  let result = "";
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];

    // Inside string
    if (inString) {
      if (ch === "\\") {
        // Escaped character — take as-is
        result += ch + (raw[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
        result += ch;
        i++;
        continue;
      }
      // Real newline inside string — escape it
      if (ch === "\n") {
        result += "\\n";
        i++;
        continue;
      }
      if (ch === "\r") {
        result += "\\r";
        i++;
        continue;
      }
      if (ch === "\t") {
        result += "\\t";
        i++;
        continue;
      }
      result += ch;
      i++;
      continue;
    }

    // Outside string: check for comments
    if (ch === "/" && raw[i + 1] === "/") {
      // Skip to end of line
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      // Skip block comment
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    result += ch;
    i++;
  }
  return result;
}

/** Extracts the first JSON object from a string (handles nesting). */
function extractJsonObject(str) {
  const start = str.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
    } else {
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return str.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function parseToolCalls(text) {
  const calls = [];

  function tryJson(str) {
    if (!str) return null;
    try {
      return JSON.parse(repairJson(str));
    } catch {
      return null;
    }
  }

  function pushCall(name, args) {
    if (!name || typeof name !== "string") return;
    const cleanName = name.trim().replace(/^['"`]+|['"`]+$/g, "");
    if (!cleanName) return;
    calls.push({
      id: `call_${Date.now()}${calls.length}`,
      type: "function",
      function: { name: cleanName, arguments: JSON.stringify(args ?? {}) },
    });
  }

  function extractArgs(parsed) {
    return (
      parsed.arguments ??
      parsed.params ??
      parsed.parameters ??
      parsed.input ??
      parsed.action_input ??
      {}
    );
  }

  // =========================================================
  // GROUP 1: code blocks (most reliable — explicit markers)
  // =========================================================

  // ```tool_call\n{...}\n```
  // ```function\n{...}\n```
  // ```tool\n{...}\n```
  let m;
  const codeBlockRe = /```(?:tool_call|function|tool)\s*([\s\S]*?)```/g;
  while ((m = codeBlockRe.exec(text)) !== null) {
    const parsed = tryJson(m[1]);
    if (parsed?.name) pushCall(parsed.name, extractArgs(parsed));
  }

  // Bare tool_call without backticks:
  //   tool_call\n{...}   or   \ntool_call\n{...}
  // (model sometimes omits the ``` fence)
  const bareToolCallRe = /(?:^|\n)tool_call\s*\n(\{[\s\S]*?\})\s*(?=\n|$)/g;
  while ((m = bareToolCallRe.exec(text)) !== null) {
    const parsed = tryJson(m[1]);
    if (parsed?.name) pushCall(parsed.name, extractArgs(parsed));
  }

  // ```json\n{"name":..., "arguments":...}\n```  (only when name/tool field present)
  const jsonBlockRe = /```json\s*([\s\S]*?)```/g;
  while ((m = jsonBlockRe.exec(text)) !== null) {
    const parsed = tryJson(m[1]);
    if (!parsed) continue;
    const name =
      parsed.name ?? parsed.tool ?? parsed.function_name ?? parsed.tool_name;
    if (name) pushCall(name, extractArgs(parsed));
  }

  if (calls.length > 0) return calls;

  // =========================================================
  // GROUP 2: XML / tag formats
  // =========================================================

  // <tool_call>{...}</tool_call>
  // <tool_call name="...">{...}</tool_call>
  const xmlToolCallRe =
    /<tool_call(?:\s+name="([^"]*)")?>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = xmlToolCallRe.exec(text)) !== null) {
    const nameAttr = m[1];
    const parsed = tryJson(m[2]);
    if (nameAttr) {
      pushCall(nameAttr, parsed ?? {});
    } else if (parsed?.name) {
      pushCall(parsed.name, extractArgs(parsed));
    }
  }

  // <function_calls><invoke name="tool"><parameter name="p">v</parameter></invoke></function_calls>
  // (Claude XML format)
  const invokeRe = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g;
  while ((m = invokeRe.exec(text)) !== null) {
    const name = m[1];
    const params = {};
    const paramRe = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramRe.exec(m[2])) !== null) {
      const val = pm[2].trim();
      try {
        params[pm[1]] = JSON.parse(val);
      } catch {
        params[pm[1]] = val;
      }
    }
    pushCall(name, params);
  }

  // <function name="tool">\n{...}\n</function>
  const xmlFunctionRe =
    /<function\s+name="([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/function>/g;
  while ((m = xmlFunctionRe.exec(text)) !== null) {
    const name = m[1];
    const jsonStr = extractJsonObject(m[2]);
    const parsed = tryJson(jsonStr ?? m[2]);
    pushCall(name, parsed ?? {});
  }

  // [TOOL_CALL]{...}[/TOOL_CALL]
  const bracketToolRe = /\[TOOL_CALL\]\s*([\s\S]*?)\s*\[\/TOOL_CALL\]/gi;
  while ((m = bracketToolRe.exec(text)) !== null) {
    const parsed = tryJson(m[1]);
    if (parsed?.name) pushCall(parsed.name, extractArgs(parsed));
  }

  // <|tool_call|>{...}<|/tool_call|>  (Mistral / Llama special tokens)
  const specialTokenRe = /<\|tool_call\|>\s*([\s\S]*?)\s*<\|\/tool_call\|>/g;
  while ((m = specialTokenRe.exec(text)) !== null) {
    const parsed = tryJson(m[1]);
    if (parsed?.name) pushCall(parsed.name, extractArgs(parsed));
  }

  // [tool: name]\n{...}  or  [TOOL: name]\n{...}
  const bracketColonRe =
    /\[(?:tool|TOOL|function|FUNCTION):\s*(\w[\w.]*)\]\s*([\s\S]*?)(?=\[(?:tool|TOOL|function|FUNCTION):|$)/g;
  while ((m = bracketColonRe.exec(text)) !== null) {
    const jsonStr = extractJsonObject(m[2]);
    if (jsonStr) {
      const parsed = tryJson(jsonStr);
      if (parsed) pushCall(m[1], parsed);
    }
  }

  if (calls.length > 0) return calls;

  // =========================================================
  // GROUP 3: key-value string formats
  // =========================================================

  // Action: name\nAction Input: {...}  (ReAct / LangChain / Qwen / ChatGLM)
  {
    const actionRe = /^Action:\s*(.+?)\s*$/gm;
    while ((m = actionRe.exec(text)) !== null) {
      const name = m[1].replace(/[`'"]/g, "").trim();
      const after = text.slice(m.index + m[0].length);
      const inputIdx = after.search(/^Action Input:\s*/m);
      if (inputIdx !== -1) {
        const afterInput = after
          .slice(inputIdx)
          .replace(/^Action Input:\s*/m, "");
        const jsonStr = extractJsonObject(afterInput);
        const parsed = tryJson(jsonStr);
        pushCall(name, parsed ?? {});
      }
    }
  }

  // Tool: name\nArguments: {...}
  // Function: name\nParameters/Params: {...}
  // TOOL: name\nINPUT: {...}
  {
    const kvPatterns = [
      { nameRe: /^Tool:\s*(.+?)\s*$/m, argsRe: /^Arguments:\s*/m },
      {
        nameRe: /^Function:\s*(.+?)\s*$/m,
        argsRe: /^(?:Parameters|Params|Arguments|Input):\s*/m,
      },
      {
        nameRe: /^TOOL:\s*(.+?)\s*$/m,
        argsRe: /^(?:INPUT|ARGUMENTS|PARAMETERS|PARAMS):\s*/m,
      },
      {
        nameRe: /^use_tool:\s*(.+?)\s*$/m,
        argsRe: /^(?:with|params|arguments):\s*/m,
      },
    ];
    for (const { nameRe, argsRe } of kvPatterns) {
      let remaining = text;
      while (true) {
        const toolIdx = remaining.search(nameRe);
        if (toolIdx === -1) break;
        const nameMatch = nameRe.exec(remaining.slice(toolIdx));
        if (!nameMatch) break;
        const name = nameMatch[1].replace(/[`'"]/g, "").trim();
        const afterName = remaining.slice(toolIdx + nameMatch[0].length);
        const argsIdx = afterName.search(argsRe);
        if (argsIdx === -1) {
          remaining = afterName;
          continue;
        }
        const afterArgs = afterName.slice(argsIdx).replace(argsRe, "");
        const jsonStr = extractJsonObject(afterArgs);
        const parsed = tryJson(jsonStr);
        if (parsed) pushCall(name, parsed);
        remaining = afterArgs.slice(jsonStr ? jsonStr.length : 1);
      }
    }
  }

  // Call: name\n{...}  (DeepSeek via vscode.lm)
  // Calling: name\n{...}
  // Invoke: name\n{...}
  // Execute: name\n{...}
  // Run: name\n{...}
  {
    const prefixRe =
      /^(?:Call|Calling|Invoke|Execute|Run|Using tool|Tool call):\s*(.+?)\s*$/gm;
    while ((m = prefixRe.exec(text)) !== null) {
      const name = m[1].replace(/[`'"]/g, "").trim();
      const after = text.slice(m.index + m[0].length);
      const jsonStr = extractJsonObject(after);
      const parsed = tryJson(jsonStr);
      if (parsed) pushCall(name, parsed);
    }
  }

  // use_tool(name, {...})  (Python-like)
  {
    const pythonRe =
      /\buse_tool\s*\(\s*["']?([\w.]+)["']?\s*,\s*(\{[\s\S]*?\})\s*\)/g;
    while ((m = pythonRe.exec(text)) !== null) {
      const parsed = tryJson(m[2]);
      if (parsed) pushCall(m[1], parsed);
    }
  }

  if (calls.length > 0) return calls;

  // =========================================================
  // GROUP 4: bare top-level JSON (least reliable)
  // =========================================================
  {
    let remaining = text;
    while (true) {
      const jsonStr = extractJsonObject(remaining);
      if (!jsonStr) break;
      const parsed = tryJson(jsonStr);
      if (parsed) {
        // {"name": "...", "arguments": {...}}
        // {"tool": "...", "parameters": {...}}
        // {"tool_name": "...", "tool_input": {...}}
        const name =
          parsed.name ??
          parsed.tool ??
          parsed.function_name ??
          parsed.tool_name ??
          parsed.tool_use?.name;
        if (name) {
          const args =
            parsed.arguments ??
            parsed.params ??
            parsed.parameters ??
            parsed.input ??
            parsed.tool_input ??
            parsed.tool_use?.input ??
            {};
          pushCall(name, args);
        }
        // {"action": "name", "action_input": {...}}  (LangChain)
        else if (parsed.action && parsed.action !== "Final Answer") {
          pushCall(parsed.action, parsed.action_input ?? {});
        }
      }
      const idx = remaining.indexOf(jsonStr);
      remaining = remaining.slice(idx + jsonStr.length);
    }
  }

  return calls;
}
