import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import type {
  AIModelInfo,
  AIStreamChunk,
  AIToolDefinition,
} from "../../src/providers/types";
import { VSCodeLMAdapter } from "../../src/vscode/VSCodeLMAdapter";

const MODEL: AIModelInfo = {
  id: "m",
  name: "M",
  family: "F",
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  capabilities: { toolCalling: true },
};

class Scripted extends BaseAIProvider {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  constructor(private readonly chunks: AIStreamChunk[]) {
    super();
  }
  getModels() {
    return [MODEL];
  }
  async isAuthenticated() {
    return true;
  }
  async login() {}
  async logout() {}
  async *sendMessageStream() {
    yield* this.chunks;
  }
}

type Part = { kind: string; value?: unknown; name?: string; input?: unknown };

const READ_FILE: AIToolDefinition = {
  name: "read_file",
  description: "Read",
  parameters: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      startLine: { type: "integer" },
      endLine: { type: "integer" },
    },
  },
};

async function respond(chunks: AIStreamChunk[], tools: AIToolDefinition[] = [READ_FILE]) {
  const parts: Part[] = [];
  await new VSCodeLMAdapter(new Scripted(chunks), {} as never).provideLanguageModelChatResponse(
    { id: "m" } as never,
    [],
    {
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
      toolMode: 1,
    } as never,
    { report: (p: Part) => parts.push(p) },
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as never,
  );
  return {
    text: parts.filter((p) => p.kind === "text").map((p) => String(p.value)).join(""),
    calls: parts.filter((p) => p.kind === "tool").map((p) => ({ name: p.name, input: p.input })),
  };
}

describe("adapter recovery", () => {
  it("recovers a call the model wrote into its reasoning instead of the answer", async () => {
    const out = await respond([
      {
        type: "thinking",
        content: 'I should read it.\n```tool_call\n{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```',
      },
    ]);
    expect(out.calls).toEqual([
      { name: "read_file", input: { filePath: "a.ts", startLine: 1, endLine: 2000 } },
    ]);
  });

  it("does not invent a call from reasoning when an answer already came", async () => {
    const out = await respond([
      { type: "thinking", content: '```tool_call\n{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```' },
      {
        type: "tool_call",
        callId: "c1",
        name: "read_file",
        argumentsPart: '{"filePath":"b.ts"}',
      },
    ]);
    expect(out.calls.map((c) => (c.input as { filePath: string }).filePath)).toEqual(["b.ts"]);
  });

  it("emits a call whose arguments arrived in pieces", async () => {
    const out = await respond([
      { type: "tool_call", callId: "c1", name: "read_file", argumentsPart: '{"filePath":' },
      { type: "tool_call", callId: "c1", name: "read_file", argumentsPart: '"a.ts"}' },
    ]);
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0].input).toMatchObject({ filePath: "a.ts" });
  });

  it("repairs read_file line numbers the model gets wrong", async () => {
    const out = await respond([
      {
        type: "tool_call",
        callId: "c1",
        name: "read_file",
        argumentsPart: '{"filePath":"a.ts","startLine":0,"endLine":0}',
      },
    ]);
    expect(out.calls[0].input).toEqual({ filePath: "a.ts", startLine: 1, endLine: 2000 });
  });

  it("removes an echoed tool result from the visible answer", async () => {
    const out = await respond([
      { type: "text", content: "Here is the file.\n" },
      { type: "text", content: "[Tool result id=call_1] {\"content\":\"secret\"}\n" },
    ]);
    expect(out.text).toContain("Here is the file.");
    expect(out.text).not.toContain("Tool result id=");
  });
});
