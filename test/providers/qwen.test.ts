import { afterEach, describe, expect, it, vi } from "vitest";
import { QwenApiClient } from "../../src/providers/qwen/QwenApiClient";
import {
  AuthExpiredError,
  ProviderError,
  WafChallengeError,
} from "../../src/providers/types";
import { collect, mockFetch, sse } from "../helpers";

// Stream records in the shape chat.qwen.ai sends (choices[].delta + phase).
const answer = (content: string, phase = "answer") => ({
  choices: [{ delta: { role: "assistant", content, phase, status: "typing" } }],
});
const usage = { usage: { input_tokens: 12, output_tokens: 3 } };

const CREATE_CHAT = {
  match: /\/api\/v2\/chats\/new/,
  contentType: "application/json",
  body: JSON.stringify({ success: true, data: { id: "chat-1" } }),
};

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { filePath: { type: "string" } } },
  },
];

function send(params: Record<string, unknown> = {}) {
  return collect(
    new QwenApiClient().sendMessageStream(
      {
        model: "qwen3.8-max",
        messages: [{ role: "user", content: "hi" }],
        ...params,
      } as never,
      "token-abc",
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Qwen client", () => {
  it("creates a chat, then streams the answer and usage", async () => {
    const requests = mockFetch([
      CREATE_CHAT,
      {
        match: /\/chat\/completions\?chat_id=chat-1/,
        body: sse(answer("Hel"), answer("lo!"), usage, "[DONE]"),
      },
    ]);

    const out = await send();

    expect(out.text).toBe("Hello!");
    expect(out.usage).toEqual({ promptTokens: 12, completionTokens: 3 });
    const post = requests.find((r) => r.url.includes("chat/completions"));
    expect(post?.headers.authorization).toBe("Bearer token-abc");
    expect(JSON.stringify(post?.body)).toContain("hi");
  });

  it("routes the think phase to the reasoning channel", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        body: sse(answer("Let me think", "think"), answer("Done.")),
      },
    ]);
    const out = await send();
    expect(out.thinking).toBe("Let me think");
    expect(out.text).toBe("Done.");
  });

  it("turns the text tool protocol into a tool call", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        body: sse(
          answer("```tool_call\n"),
          answer('{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```'),
        ),
      },
    ]);
    const out = await send({ tools: TOOLS, toolMode: "auto" });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "a.ts" } }]);
    expect(out.text).toBe("");
  });

  it("recovers a native function_call", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        body: sse({
          choices: [
            {
              delta: {
                function_call: {
                  name: "read_file",
                  arguments: '{"filePath":"b.ts"}',
                },
              },
            },
          ],
        }),
      },
    ]);
    const out = await send({ tools: TOOLS, toolMode: "auto" });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "b.ts" } }]);
  });

  it("keeps Qwen's own tool-registry rejections out of the answer", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        body: sse(
          { choices: [{ delta: { role: "function", name: "read_file", content: "Tool not found" } }] },
          answer("Answer."),
        ),
      },
    ]);
    const out = await send();
    expect(out.text).toBe("Answer.");
  });

  it("reports a success:false body instead of an empty answer", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        body: JSON.stringify({
          success: false,
          data: { code: "Bad_Request", details: "model not found" },
        }),
      },
    ]);
    await expect(send()).rejects.toThrow(/Bad_Request: model not found/);
  });

  it("recognises the Aliyun WAF page as an anti-bot challenge", async () => {
    mockFetch([
      CREATE_CHAT,
      {
        match: /chat\/completions/,
        contentType: "text/html",
        body: "<!doctype html><meta name=aliyun_waf_aa>",
      },
    ]);
    await expect(send()).rejects.toBeInstanceOf(WafChallengeError);
  });

  it("maps 401 to an expired session", async () => {
    mockFetch([
      CREATE_CHAT,
      { match: /chat\/completions/, status: 401, contentType: "application/json", body: "{}" },
    ]);
    await expect(send()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("explains a failed chat creation", async () => {
    mockFetch([
      {
        match: /chats\/new/,
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ success: false, data: { code: "Internal", details: "boom" } }),
      },
    ]);
    await expect(send()).rejects.toBeInstanceOf(ProviderError);
  });
});
