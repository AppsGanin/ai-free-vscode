import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import type {
  AIModelInfo,
  AIRequestParams,
  AIStreamChunk,
  AIToolDefinition,
} from "../../src/providers/types";
import { VSCodeLMAdapter } from "../../src/vscode/VSCodeLMAdapter";

/** A provider that replays a fixed list of chunks. */
class ScriptedProvider extends BaseAIProvider {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  constructor(
    private readonly chunks: AIStreamChunk[],
    private readonly models: AIModelInfo[] = [MODEL],
  ) {
    super();
  }
  getModels() {
    return this.models;
  }
  async isAuthenticated() {
    return true;
  }
  async login() {}
  async logout() {}
  async *sendMessageStream(_params: AIRequestParams) {
    yield* this.chunks;
  }
}

const MODEL: AIModelInfo = {
  id: "m",
  name: "M",
  family: "F",
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  capabilities: { toolCalling: true },
};

type Part = { kind: string; value?: unknown; name?: string; input?: unknown };

/** Runs one chat request and returns the parts VS Code would receive. */
async function respond(
  chunks: AIStreamChunk[],
  tools: AIToolDefinition[] = [],
): Promise<Part[]> {
  const adapter = new VSCodeLMAdapter(
    new ScriptedProvider(chunks),
    { get: async () => undefined } as never,
  );
  const parts: Part[] = [];
  await adapter.provideLanguageModelChatResponse(
    { id: "m" } as never,
    [],
    {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
      toolMode: 1,
    } as never,
    { report: (p: Part) => parts.push(p) },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as never,
  );
  return parts.filter((p) => p.kind !== "data");
}

/** Consecutive parts of one kind merged: the shape the chat UI renders. */
function runs(parts: Part[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const p of parts) {
    const value =
      p.kind === "tool" ? `${p.name} ${JSON.stringify(p.input)}` : String(p.value);
    const last = out[out.length - 1];
    if (last && last[0] === p.kind && p.kind !== "tool") last[1] += value;
    else out.push([p.kind, value]);
  }
  return out;
}

describe("thinking/answer order", () => {
  it("never lets reasoning arrive after the answer has started", async () => {
    // The shape of a GLM-5.3 stream: reasoning that ends mid-sentence, the
    // answer, a usage record in the middle of it, the rest of the answer.
    // Leftover reasoning used to be flushed on the usage record; VS Code then
    // folded the first part of the answer into the reasoning block and the
    // visible reply started mid-word.
    const parts = await respond([
      { type: "thinking", content: "Let me review.\nI will list the issues" },
      { type: "text", content: "## Что можно поправить\n\n1. Ло" },
      { type: "text", content: "ги не пишутся. " },
      { type: "usage", promptTokens: 10, completionTokens: 20 },
      { type: "text", content: "Фикс — одна строка.\n" },
    ]);

    expect(runs(parts)).toEqual([
      ["thinking", "Let me review.\nI will list the issues"],
      ["text", "## Что можно поправить\n\n1. Логи не пишутся. Фикс — одна строка.\n"],
    ]);
  });
});

const VIEW: AIToolDefinition = {
  name: "view",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      view_range: { type: "array", items: { type: "integer" } },
    },
  },
};

const GREP: AIToolDefinition = {
  name: "grep_search",
  description: "Search",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      isRegexp: { type: "boolean" },
      maxResults: { type: "integer" },
      includePattern: { type: ["string", "null"] },
      filePaths: { type: "array", items: { type: "string" } },
    },
  },
};

async function callInput(
  tool: AIToolDefinition,
  args: Record<string, unknown>,
): Promise<unknown> {
  const parts = await respond(
    [
      {
        type: "tool_call",
        callId: "c1",
        name: tool.name,
        argumentsPart: JSON.stringify(args),
      },
    ],
    [tool],
  );
  return parts.find((p) => p.kind === "tool")?.input;
}

describe("tool arguments are re-typed against the tool schema", () => {
  // VS Code validates the input against the schema and drops a call that
  // does not match — the model then wastes a full turn retrying.
  it.each([
    ['"1-180"', "1-180", [1, 180]],
    ['"1:120"', "1:120", [1, 120]],
    ['"10:-1" (to end of file)', "10:-1", [10, -1]],
    ['"1..80"', "1..80", [1, 80]],
    ['"1, 80"', "1, 80", [1, 80]],
    ['"1 to 80"', "1 to 80", [1, 80]],
    ["JSON string", "[1,180]", [1, 180]],
    ["already an array", [1, 180], [1, 180]],
    ["unreadable text is left for the tool to reject", "start-end", "start-end"],
  ])("view_range %s", async (_label, value, expected) => {
    expect(await callInput(VIEW, { path: "a.ts", view_range: value })).toEqual({
      path: "a.ts",
      view_range: expected,
    });
  });

  it("undoes the XML parser's number/boolean guesses for string params", async () => {
    expect(
      await callInput(GREP, { query: 2024, includePattern: 5 }),
    ).toMatchObject({ query: "2024", includePattern: "5" });
    expect(await callInput(GREP, { query: true })).toMatchObject({
      query: "true",
    });
  });

  it("parses numbers and booleans that arrived as text", async () => {
    expect(
      await callInput(GREP, { query: "x", isRegexp: "false", maxResults: "20" }),
    ).toMatchObject({ isRegexp: false, maxResults: 20 });
  });

  it("wraps a single value where a list of strings is due", async () => {
    expect(
      await callInput(GREP, { query: "x", filePaths: "src/a.ts" }),
    ).toMatchObject({ filePaths: ["src/a.ts"] });
  });

  it("leaves parameters the tool did not declare alone", async () => {
    expect(await callInput(GREP, { query: "x", extra: 42 })).toMatchObject({
      extra: 42,
    });
  });
});

describe("model list for the chat picker", () => {
  it("passes toolCalling through, which Agent mode requires", async () => {
    const adapter = new VSCodeLMAdapter(
      new ScriptedProvider([], [MODEL]),
      { get: async () => undefined } as never,
    );
    const [info] = await adapter.provideLanguageModelChatInformation();
    expect(info.capabilities.toolCalling).toBe(true);
  });

  it("hides models marked chat: false", async () => {
    const adapter = new VSCodeLMAdapter(
      new ScriptedProvider([], [
        MODEL,
        { ...MODEL, id: "hidden", capabilities: { chat: false } },
      ]),
      { get: async () => undefined } as never,
    );
    const ids = (await adapter.provideLanguageModelChatInformation()).map(
      (m) => m.id,
    );
    expect(ids).toEqual(["m"]);
  });
});

describe("adapter debug log", () => {
  it("tags the request's lines with one id and records the raw model output", async () => {
    const { setOutputChannel } = await import("../../src/logger");
    const { setSetting } = await import("../mocks/vscode");
    const lines: string[] = [];
    setOutputChannel({ appendLine: (l: string) => lines.push(l) } as never);
    setSetting("freeAI.debug", true);
    try {
      await respond([{ type: "text", content: "Hello\nworld" }]);
    } finally {
      setSetting("freeAI.debug", undefined);
    }
    const ids = new Set(lines.map((l) => /\[#(\w{4})\]/.exec(l)?.[1]));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    expect(lines.join("\n")).toMatch(/first text chunk after \d+ms/);
    expect(lines.join("\n")).toContain("raw text: Hello\\nworld");
  });
});
