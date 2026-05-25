/**
 * Utilities for converting VS Code tool definitions into the OpenAI function-
 * calling schema expected by messagesToPrompt(), and for safely parsing the
 * model's tool-call argument JSON.
 */

import { error as logError, warn } from "./logger.mjs";

/** Line-number bounds used when patching read_file-style tool schemas. */
export const MIN_LINE_NUMBER = 1;
export const MAX_LINE_NUMBER = 9999;

/**
 * Normalises an inputSchema into a valid JSON Schema object.
 * Ensures `type` defaults to "object" and `properties` is present for objects.
 *
 * @param {unknown} inputSchema
 * @returns {Record<string, unknown>}
 */
export function normalizeToolParameters(inputSchema) {
  const fallback = { type: "object", properties: {} };
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  ) {
    return fallback;
  }
  const schema = { ...inputSchema };
  if (!("type" in schema)) schema.type = "object";
  if (schema.type === "object" && !("properties" in schema))
    schema.properties = {};
  return schema;
}

/**
 * Converts LanguageModelChatTool[] → OpenAI function-calling definitions
 * suitable for messagesToPrompt().
 *
 * Also patches `startLine` / `endLine` parameter descriptions so the model
 * generates valid 1-based line numbers.
 *
 * @param {readonly import("vscode").LanguageModelChatTool[] | undefined} tools
 * @returns {Array<{type: "function", function: {name: string, description: string, parameters: object}}>}
 */
export function convertToolSchemas(tools) {
  return (tools ?? []).map((t) => {
    const schema = normalizeToolParameters(t.inputSchema);
    const props = schema.properties ?? {};

    if ("startLine" in props || "endLine" in props) {
      const enhanced = JSON.parse(JSON.stringify(schema));
      if (enhanced.properties.startLine) {
        enhanced.properties.startLine.description = `1-based line number to start reading from (inclusive). Default: ${MIN_LINE_NUMBER}`;
      }
      if (enhanced.properties.endLine) {
        enhanced.properties.endLine.description = `1-based line number to end reading at (inclusive). To read the whole file use ${MAX_LINE_NUMBER}. Must be >= startLine.`;
      }
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: enhanced,
        },
      };
    }

    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: schema,
      },
    };
  });
}

/**
 * Safely parses the tool-call argument JSON string produced by the model.
 *
 * On success returns a plain object.
 * On failure logs the error and returns `{ rawArguments: raw }` so callers
 * can at least see what the model sent instead of silently losing data.
 *
 * @param {string} raw
 * @param {string} toolName  Used in the error log message.
 * @returns {object}
 */
export function parseToolArguments(raw, toolName) {
  const text = raw?.trim() ?? "";
  if (!text) return {};
  try {
    // Quick repair: strip trailing commas before } or ]
    const repaired = text.replace(/,\s*([}\]])/g, "$1");
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: parsed };
  } catch {
    logError(`Failed to parse tool call arguments for "${toolName}": ${raw}`);
    return { rawArguments: raw };
  }
}

/**
 * Clamps / fixes numeric line-range parameters that the model sometimes
 * generates incorrectly.
 *
 * Mutates `input` in place and emits `warn` log entries for each fix applied.
 *
 * @param {object} input   Parsed tool-call argument object.
 * @param {string} toolName
 */
export function fixLineRangeParams(input, toolName) {
  if (
    "endLine" in input &&
    (input.endLine < 1 || input.endLine < (input.startLine ?? 1))
  ) {
    warn(
      `Invalid endLine=${input.endLine} in tool call "${toolName}". Setting to ${MAX_LINE_NUMBER}.`,
    );
    input.endLine = MAX_LINE_NUMBER;
  }
  if (
    "startLine" in input &&
    (input.startLine < 1 || !Number.isInteger(input.startLine))
  ) {
    input.startLine = MIN_LINE_NUMBER;
  }
}
