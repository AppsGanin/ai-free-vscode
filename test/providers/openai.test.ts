import { afterEach, describe, expect, it, vi } from "vitest";
import {
  streamChatCompletion,
  type RequestContext,
} from "../../src/providers/openai/OpenAICompatApiClient";
import { AuthExpiredError, RateLimitError } from "../../src/providers/types";
import { mockFetch, sse } from "../helpers";
import type { AIStreamChunk } from "../../src/providers/types";

const CTX: RequestContext = {
  providerId: "custom-test",
  config: { id: "test", name: "Test", baseUrl: "https://llm.example/v1" },
  apiKey: "sk-test",
};

const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d }] });

/** Text, reasoning and tool calls, with call arguments joined per call id. */
async function run(params: Record<string, unknown> = {}) {
  const chunks: AIStreamChunk[] = [];
  for await (const c of streamChatCompletion(
    { model: "m", messages: [{ role: "user", content: "hi" }], ...params } as never,
    CTX,
  )) {
    chunks.push(c);
  }
  const calls = new Map<string, { name: string; args: string }>();
  for (const c of chunks) {
    if (c.type !== "tool_call") continue;
    const call = calls.get(c.callId) ?? { name: c.name, args: "" };
    call.args += c.argumentsPart;
    calls.set(c.callId, call);
  }
  return {
    text: chunks.map((c) => (c.type === "text" ? c.content : "")).join(""),
    thinking: chunks.map((c) => (c.type === "thinking" ? c.content : "")).join(""),
    calls: [...calls.values()].map((c) => ({ name: c.name, args: JSON.parse(c.args) })),
    usage: chunks.find((c) => c.type === "usage"),
  };
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read",
    parameters: { type: "object", properties: { filePath: { type: "string" } } },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible client", () => {
  it("streams text, reasoning and usage", async () => {
    const requests = mockFetch([
      {
        match: /\/chat\/completions$/,
        body: sse(
          delta({ reasoning_content: "thinking…" }),
          delta({ content: "Hel" }),
          delta({ content: "lo" }),
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
          "[DONE]",
        ),
      },
    ]);
    const out = await run();
    expect(out.thinking).toBe("thinking…");
    expect(out.text).toBe("Hello");
    expect(out.usage).toMatchObject({ promptTokens: 5, completionTokens: 2 });
    expect(requests[0].headers.authorization).toBe("Bearer sk-test");
    expect(requests[0].body).toMatchObject({ model: "m", stream: true });
  });

  it("assembles native tool calls streamed in pieces", async () => {
    const requests = mockFetch([
      {
        match: /\/chat\/completions$/,
        body: sse(
          delta({ tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '{"filePath":' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
          "[DONE]",
        ),
      },
    ]);
    const out = await run({ tools: TOOLS, toolMode: "auto" });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "a.ts" } }]);
    expect(requests[0].body).toMatchObject({ tool_choice: "auto" });
  });

  it("retries once without the optional fields a server rejects", async () => {
    let attempt = 0;
    const requests = mockFetch([
      {
        match: /\/chat\/completions$/,
        status: 400,
        contentType: "application/json",
        body: () => (attempt++ === 0 ? '{"error":"unknown field stream_options"}' : ""),
      },
    ]);
    // Second response: replace the route with a good one after the first call.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (requests.length === 0) return original(input, init);
      requests.push({ url: input, method: "POST", headers: {}, body: JSON.parse(String(init?.body)) });
      return new Response(sse(delta({ content: "ok" }), "[DONE]"), {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const out = await run();
    expect(out.text).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(requests[1].body).not.toHaveProperty("stream_options");
  });

  it("accepts a plain JSON completion from a server that ignores stream", async () => {
    mockFetch([
      {
        match: /\/chat\/completions$/,
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { content: "whole answer" } }] }),
      },
    ]);
    expect((await run()).text).toBe("whole answer");
  });

  it.each([
    [401, AuthExpiredError],
    [429, RateLimitError],
  ])("maps HTTP %d", async (status, type) => {
    mockFetch([{ match: /\/chat\/completions$/, status, contentType: "application/json", body: "{}" }]);
    await expect(run()).rejects.toBeInstanceOf(type);
  });
});
