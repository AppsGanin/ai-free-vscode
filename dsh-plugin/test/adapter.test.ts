import { INVALID_CREDENTIAL_CODE, LlmError, MessageId, type StreamChunk, ToolCallId } from "@deepseek-ai/dsh-llm";
import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../../src/providers/types";
import { AuthExpiredError } from "../../src/providers/types";
import { memorySecrets } from "../../test/helpers";
import { FreeAiAdapter } from "../src/adapter";
import { toAIMessages } from "../src/messages";

const MODEL: AIModelInfo = {
  id: "m1",
  name: "Model One",
  family: "F",
  maxInputTokens: 128000,
  maxOutputTokens: 8000,
  capabilities: { chat: true, toolCalling: true, thinking: true },
};

class FakeProvider extends BaseAIProvider {
  readonly id = "fake";
  readonly displayName = "Fake (Web)";
  signedIn = true;
  logins = 0;
  seen: AIRequestParams[] = [];
  constructor(private readonly script: () => AsyncIterable<AIStreamChunk>) {
    super();
  }
  getModels() {
    return [MODEL, { ...MODEL, id: "hidden", capabilities: { chat: false } }];
  }
  async isAuthenticated() {
    return this.signedIn;
  }
  async login() {
    this.logins++;
    this.signedIn = true;
  }
  async logout() {}
  async *sendMessageStream(params: AIRequestParams) {
    this.seen.push(params);
    yield* this.script();
  }
}

const adapterFor = (provider: FakeProvider, autoSignIn = true) =>
  new FreeAiAdapter([{ id: "fake-web", name: provider.displayName, provider }], memorySecrets(), autoSignIn);

async function run(adapter: FreeAiAdapter, tools = false): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of adapter.stream({
    provider: "fake-web",
    model: "m1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...(tools ? { tools: [{ name: "view", description: "Read a file", parameters: { type: "object" } }] } : {}),
  })) {
    out.push(chunk);
  }
  return out;
}

describe("harness messages → transcript", () => {
  it("writes tool traffic in the prompt-protocol shape the parsers expect", () => {
    const id = ToolCallId("call_1");
    const messages = toAIMessages(
      [
        { id: MessageId("s"), role: "system", source: { kind: "system-prompt" }, content: [{ type: "text", text: "Be brief." }] },
        { role: "user", content: [{ type: "text", text: "show app.ts" }] },
        {
          id: MessageId("a"),
          role: "assistant",
          source: { kind: "model", provider: "fake-web", model: "m1" },
          content: [
            { type: "reasoning", text: "secret thoughts" },
            { type: "text", text: "Reading it." },
            { type: "tool-call", id, name: "view", arguments: '{"path":"app.ts"}' },
          ],
        },
        { id: MessageId("t"), role: "tool", source: { kind: "tool", callId: id }, toolCallId: id, content: [{ type: "text", text: "line 1" }] },
      ],
      undefined,
    );
    expect(messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "show app.ts" },
      {
        role: "assistant",
        content: 'Reading it.\n\n```tool_call\n{\n  "name": "view",\n  "arguments": {\n    "path": "app.ts"\n  }\n}\n```',
      },
      { role: "user", content: "[Tool result id=call_1]\nline 1" },
    ]);
  });
});

describe("FreeAiAdapter", () => {
  it("lists only the models usable for chat", async () => {
    const adapter = adapterFor(new FakeProvider(async function* () {}));
    expect((await adapter.listModels("fake-web")).map((m) => m.id)).toEqual(["m1"]);
    expect((await adapter.resolveModel("fake-web", "m1")).context).toEqual({ contextWindow: 128000 });
  });

  it("streams reasoning, text and a tool call as harness blocks", async () => {
    const provider = new FakeProvider(async function* () {
      yield { type: "thinking", content: "hmm" };
      yield { type: "text", content: "Let me look." };
      yield { type: "tool_call", callId: "c1", name: "view", argumentsPart: '{"path":"a.ts"}' };
      yield { type: "usage", promptTokens: 10, completionTokens: 5 };
    });
    const chunks = await run(adapterFor(provider), true);
    expect(chunks).toEqual([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "hmm" },
      { type: "block-end", index: 0, block: { type: "reasoning", text: "hmm" } },
      { type: "block-start", index: 1, blockType: "text" },
      { type: "text-delta", index: 1, text: "Let me look." },
      { type: "block-end", index: 1, block: { type: "text", text: "Let me look." } },
      { type: "block-start", index: 2, blockType: "tool-call" },
      { type: "tool-call-delta", index: 2, id: "c1", name: "view", argumentsDelta: '{"path":"a.ts"}' },
      { type: "block-end", index: 2, block: { type: "tool-call", id: "c1", name: "view", arguments: '{"path":"a.ts"}' } },
      { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
      { type: "finish", reason: { kind: "tool-calls" } },
    ]);
    expect(provider.seen[0]).toMatchObject({ model: "m1", toolMode: "auto", thinkingMode: "auto" });
  });

  it("recovers a tool call written into the text", async () => {
    const provider = new FakeProvider(async function* () {
      yield { type: "text", content: '```tool_call\n{"name":"view","arguments":{"path":"b.ts"}}\n```' };
    });
    const chunks = await run(adapterFor(provider), true);
    const call = chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call");
    expect(call).toMatchObject({ block: { name: "view", arguments: '{"path":"b.ts"}' } });
    expect(chunks.at(-1)).toEqual({ type: "finish", reason: { kind: "tool-calls" } });
  });

  it("reports a refused session as an invalid credential", async () => {
    const provider = new FakeProvider(async function* () {
      throw new AuthExpiredError("fake", 401);
    });
    const failure = await run(adapterFor(provider)).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).failure).toMatchObject({ code: INVALID_CREDENTIAL_CODE, status: 401 });
  });

  it("opens the sign-in window when there is no session", async () => {
    const provider = new FakeProvider(async function* () {
      yield { type: "text", content: "ok" };
    });
    provider.signedIn = false;
    await run(adapterFor(provider));
    expect(provider.logins).toBe(1);

    provider.signedIn = false;
    const failure = await run(adapterFor(provider, false)).catch((err: unknown) => err);
    expect((failure as LlmError).failure.code).toBe(INVALID_CREDENTIAL_CODE);
  });
});
