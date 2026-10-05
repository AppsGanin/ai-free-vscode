import type { VSCodeLMAdapter } from "../../../src/vscode/VSCodeLMAdapter";
import * as vscode from "../../mocks/vscode";
import { ROOT, type VirtualWorkspace } from "./workspace";

/**
 * Drives a model through a multi-step agent session the way Copilot Chat
 * does: send the conversation with tools, run the calls it makes, feed the
 * results back, repeat until it answers in plain text.
 */

interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string | string[]; items?: { type: string }; description?: string }>;
  required: string[];
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

// Shapes of Copilot's own agent tools.
export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "list_dir",
    description: "List the contents of a directory. Result has the names of the child files and directories; directories end in /.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path of the directory." } },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description: "Read the contents of a file. Line numbers are 1-indexed. Read a large file in ranges.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file." },
        startLine: { type: "number", description: "Line number to start reading from, 1-based." },
        endLine: { type: "number", description: "Inclusive line number to end reading at, 1-based." },
      },
      required: ["filePath", "startLine", "endLine"],
    },
  },
  {
    name: "grep_search",
    description: "Fast text search in the workspace. Returns matching lines with file paths and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text or regex to search for." },
        isRegexp: { type: "boolean", description: "Whether the query is a regular expression." },
      },
      required: ["query", "isRegexp"],
    },
  },
  {
    name: "replace_string_in_file",
    description:
      "Edit an existing file by replacing one exact occurrence of oldString with newString. Include 3+ lines of context so the match is unique; whitespace must match exactly.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file to edit." },
        oldString: { type: "string", description: "Exact text to replace." },
        newString: { type: "string", description: "Replacement text." },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "create_file",
    description: "Create a new file with the given content (overwrites an existing file).",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path of the file." },
        content: { type: "string", description: "Full content of the file." },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "run_in_terminal",
    description: "Run a shell command in the project directory and return its output.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        explanation: { type: "string", description: "One sentence on what the command does." },
        isBackground: { type: "boolean", description: "Whether the command runs in the background." },
      },
      required: ["command", "explanation", "isBackground"],
    },
  },
];

/** Mismatches VS Code would reject the call for (missing/ill-typed args). */
export function schemaViolations(tool: ToolSpec | undefined, input: unknown): string[] {
  if (!tool) return ["unknown tool"];
  if (!input || typeof input !== "object") return ["input is not an object"];
  const args = input as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of tool.inputSchema.required) {
    if (!(key in args)) problems.push(`missing ${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = tool.inputSchema.properties[key];
    if (!spec) continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = types.some((t) => t === actual || (t === "integer" && Number.isInteger(value)));
    if (!ok) problems.push(`${key}: expected ${types.join("|")}, got ${actual}`);
  }
  return problems;
}

function execute(workspace: VirtualWorkspace, name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "list_dir":
      return workspace.listDir(String(args.path ?? ROOT));
    case "read_file":
      return workspace.readFile(
        String(args.filePath),
        args.startLine as number | undefined,
        args.endLine as number | undefined,
      );
    case "grep_search":
      return workspace.grep(String(args.query ?? ""), args.isRegexp === true);
    case "replace_string_in_file":
      return workspace.replace(String(args.filePath), String(args.oldString ?? ""), String(args.newString ?? ""));
    case "create_file":
      return workspace.createFile(String(args.filePath), String(args.content ?? ""));
    case "run_in_terminal":
      return workspace.runCommand(String(args.command ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface Step {
  turn: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Short result excerpt for the report. */
  result: string;
  violations: string[];
}

export interface AgentRun {
  steps: Step[];
  turns: number;
  finalAnswer: string;
  /** The model went past maxTurns without finishing. */
  exhausted: boolean;
  /** Turns whose reasoning was reported after their answer had begun. */
  reasoningAfterAnswer: number;
  /** Protocol text that leaked into a visible answer. */
  leaks: string[];
  error?: string;
  ms: number;
}

const LEAK = /```tool_call|<tool_call|<invoke\b|<function_calls>|\[Tool result id=|"name"\s*:\s*"tool_name"/;

type Part = { kind: string; value?: unknown; callId?: string; name?: string; input?: unknown };

/** A CancellationToken the agent loop can trip itself. */
function cancellationToken() {
  const listeners: Array<() => void> = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(listener: () => void) {
      listeners.push(listener);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const listener of listeners) listener();
    },
  };
}

export async function runAgent(
  adapter: VSCodeLMAdapter,
  model: string,
  task: string,
  workspace: VirtualWorkspace,
  options: { maxTurns?: number; turnTimeoutMs?: number; onTurn?: (line: string) => void } = {},
): Promise<AgentRun> {
  const maxTurns = options.maxTurns ?? 45;
  // One turn is a few seconds to a minute. Past this something is stuck;
  // the turn is cancelled the way the chat's Stop button does it.
  const turnTimeoutMs = options.turnTimeoutMs ?? 6 * 60_000;
  const startedAt = Date.now();
  const messages: Array<{ role: number; content: unknown[]; name: undefined }> = [
    { role: 1, content: [new vscode.LanguageModelTextPart(task)], name: undefined },
  ];
  const run: AgentRun = {
    steps: [],
    turns: 0,
    finalAnswer: "",
    exhausted: false,
    reasoningAfterAnswer: 0,
    leaks: [],
    ms: 0,
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    run.turns = turn;
    const parts: Part[] = [];
    const token = cancellationToken();
    const turnStartedAt = Date.now();
    const timer = setTimeout(() => token.cancel(), turnTimeoutMs);
    try {
      await adapter.provideLanguageModelChatResponse(
        { id: model } as never,
        messages as never,
        { tools: AGENT_TOOLS, toolMode: 1 } as never,
        { report: (p: Part) => parts.push(p) },
        token as never,
      );
    } catch (err) {
      run.error = `turn ${turn}: ${err instanceof Error ? err.message : String(err)}`;
      break;
    } finally {
      clearTimeout(timer);
    }
    if (token.isCancellationRequested) {
      run.error = `turn ${turn}: no answer within ${Math.round(turnTimeoutMs / 1000)} s (cancelled; got ${parts.length} parts so far)`;
      break;
    }
    options.onTurn?.(`turn ${turn}: model answered in ${Math.round((Date.now() - turnStartedAt) / 1000)} s`);

    const text = parts.filter((p) => p.kind === "text").map((p) => String(p.value)).join("");
    const calls = parts.filter((p) => p.kind === "tool");
    const firstText = parts.findIndex((p) => p.kind === "text");
    if (firstText >= 0 && parts.slice(firstText).some((p) => p.kind === "thinking")) {
      run.reasoningAfterAnswer++;
    }
    const leak = LEAK.exec(text);
    if (leak) run.leaks.push(`turn ${turn}: …${text.slice(Math.max(0, leak.index - 40), leak.index + 80)}…`);

    if (calls.length === 0) {
      run.finalAnswer = text;
      options.onTurn?.(`turn ${turn}: final answer (${text.length} chars)`);
      break;
    }

    messages.push({
      role: 2,
      content: [
        ...(text.trim() ? [new vscode.LanguageModelTextPart(text)] : []),
        ...calls.map((c) => new vscode.LanguageModelToolCallPart(c.callId!, c.name!, c.input as Record<string, unknown>)),
      ],
      name: undefined,
    });

    const results: unknown[] = [];
    for (const call of calls) {
      const args = (call.input ?? {}) as Record<string, unknown>;
      const tool = AGENT_TOOLS.find((t) => t.name === call.name);
      const violations = schemaViolations(tool, args);
      let result: string;
      let ok = true;
      if (violations.length > 0) {
        // What VS Code does with a call that fails its schema.
        ok = false;
        result = `ERROR: invalid input for ${call.name}: ${violations.join("; ")}`;
      } else {
        try {
          result = execute(workspace, call.name!, args);
        } catch (err) {
          ok = false;
          result = `ERROR: ${(err as Error).message}`;
        }
      }
      run.steps.push({
        turn,
        tool: call.name!,
        args,
        ok,
        result: result.replace(/\s+/g, " ").slice(0, 120),
        violations,
      });
      options.onTurn?.(
        `turn ${turn}: ${call.name} ${JSON.stringify(args).slice(0, 110)} → ${ok ? "ok" : result.slice(0, 90)}`,
      );
      results.push(new vscode.LanguageModelToolResultPart(call.callId!, [new vscode.LanguageModelTextPart(result)]));
    }
    messages.push({ role: 1, content: results, name: undefined });

    if (turn === maxTurns) run.exhausted = true;
  }

  run.ms = Date.now() - startedAt;
  return run;
}
