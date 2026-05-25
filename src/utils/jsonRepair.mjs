/**
 * Low-level JSON repair utilities used by the tool call parser.
 */

/**
 * Repairs model-generated JSON:
 * - strips // and /* comments ONLY outside string values
 * - escapes real newlines inside string values
 */
export function repairJson(raw) {
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
export function extractJsonObject(str) {
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
