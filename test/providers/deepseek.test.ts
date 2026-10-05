import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekApiClient } from "../../src/providers/deepseek/DeepSeekApiClient";
import { AuthExpiredError, ProviderError } from "../../src/providers/types";
import { collect, mockFetch, sse } from "../helpers";

// The completion stream is a JSON-patch feed: a snapshot of the response,
// then `{p, o, v}` operations and bare `{v}` continuations. These records
// follow the shapes extractDelta handles; drift in the real format is what
// the live tests are for.
const snapshot = {
  v: {
    response: {
      message_id: 2,
      parent_id: 1,
      role: "ASSISTANT",
      status: "WIP",
      fragments: [],
    },
  },
};
const newFragment = (type: string, content: string) => ({
  p: "response/fragments",
  o: "APPEND",
  v: [{ id: type === "THINK" ? 1 : 2, type, content }],
});
const appendLast = (v: string) => ({
  p: "response/fragments/-1/content",
  o: "APPEND",
  v,
});
const finished = { p: "response/status", o: "SET", v: "FINISHED" };

const AUTH = { token: "tok", cookieHeader: "ds_session_id=abc" };

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { filePath: { type: "string" } } },
  },
];

function send(params: Record<string, unknown> = {}) {
  return collect(
    new DeepSeekApiClient().sendMessageStream(
      {
        model: "deepseek-default",
        chatId: "session-1",
        messages: [{ role: "user", content: "hi" }],
        ...params,
      } as never,
      AUTH,
    ),
  );
}

beforeEach(() => {
  // The proof-of-work solver is a WASM blob solving a real challenge; the
  // request around it is what is under test here.
  vi.spyOn(
    DeepSeekApiClient.prototype as unknown as { createPowHeader: () => Promise<string> },
    "createPowHeader",
  ).mockResolvedValue("pow-answer");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DeepSeek client", () => {
  it("separates reasoning from the answer across fragments", async () => {
    mockFetch([
      {
        match: /chat\/completion$/,
        body: sse(
          snapshot,
          newFragment("THINK", "Hmm"),
          appendLast(", the user"),
          { v: " asks." },
          newFragment("RESPONSE", "Hello"),
          appendLast(" world"),
          { v: "!" },
          finished,
        ),
      },
    ]);

    const out = await send();
    expect(out.thinking).toBe("Hmm, the user asks.");
    expect(out.text).toBe("Hello world!");
  });

  it("keeps reasoning out of the answer when the snapshot opens with a THINK fragment", async () => {
    // Recorded from chat.deepseek.com (thinking on): the opening snapshot
    // already carries the THINK fragment, then plain patches continue it.
    // Its type used to go unregistered and the reasoning leaked into the
    // answer ("We need answer in Russian…").
    mockFetch([
      {
        match: /chat\/completion$/,
        body: sse(
          { request_message_id: 1, response_message_id: 2, model_type: "default" },
          { updated_at: 1791206209.64 },
          {
            v: {
              response: {
                message_id: 2,
                parent_id: 1,
                role: "ASSISTANT",
                thinking_enabled: true,
                status: "WIP",
                fragments: [{ id: 2, type: "THINK", content: "We", elapsed_secs: null, references: [], stage_id: 1 }],
              },
            },
          },
          appendLast(" need"),
          { v: " answer" },
          { v: " in Russian." },
          { p: "response/fragments/-1/elapsed_secs", o: "SET", v: 2.18 },
          {
            p: "response/fragments",
            o: "APPEND",
            v: [{ id: 3, type: "RESPONSE", content: "О", references: [], stage_id: 1 }],
          },
          { v: "ТВЕТ:" },
          { v: " готово." },
          finished,
        ),
      },
    ]);

    const out = await send();
    expect(out.thinking).toBe("We need answer in Russian.");
    expect(out.text).toBe("ОТВЕТ: готово.");
  });

  it("sends the session, the PoW header and the auth", async () => {
    const requests = mockFetch([
      { match: /chat\/completion$/, body: sse(snapshot, newFragment("RESPONSE", "ok")) },
    ]);
    await send();
    const post = requests[0];
    expect(post.headers["x-ds-pow-response"]).toBe("pow-answer");
    expect(post.headers.authorization).toBe("Bearer tok");
    expect(post.headers.cookie).toBe("ds_session_id=abc");
    expect(post.body).toMatchObject({ chat_session_id: "session-1" });
  });

  it("turns the text tool protocol into a tool call", async () => {
    mockFetch([
      {
        match: /chat\/completion$/,
        body: sse(
          snapshot,
          newFragment("RESPONSE", "```tool_call\n"),
          appendLast('{"name":"read_file","arguments":{"filePath":"a.ts"}}'),
          { v: "\n```" },
        ),
      },
    ]);
    const out = await send({ tools: TOOLS, toolMode: "auto" });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "a.ts" } }]);
  });

  it("parses the Anthropic-style XML DeepSeek falls back to (#16)", async () => {
    mockFetch([
      {
        match: /chat\/completion$/,
        body: sse(
          snapshot,
          newFragment("RESPONSE", '<invoke name="read_file">'),
          appendLast('<parameter name="filePath">src/a.ts</parameter></invoke>'),
        ),
      },
    ]);
    const out = await send({ tools: TOOLS, toolMode: "auto" });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "src/a.ts" } }]);
  });

  it("reports an in-stream error frame", async () => {
    mockFetch([
      {
        match: /chat\/completion$/,
        body: sse({
          type: "error",
          content: "Only one message at a time",
          finish_reason: "parallel_chat_limit",
        }),
      },
    ]);
    await expect(send()).rejects.toThrow(/Only one message at a time \(parallel_chat_limit\)/);
  });

  it("maps code 40003 to an expired session", async () => {
    mockFetch([
      {
        match: /chat\/completion$/,
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ code: 40003, msg: "token invalid" }),
      },
    ]);
    await expect(send()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("reports a biz error from the JSON endpoints", async () => {
    mockFetch([
      {
        match: /chat_session\/create/,
        contentType: "application/json",
        body: JSON.stringify({ code: 0, data: { biz_code: 7, biz_msg: "rate limited" } }),
      },
    ]);
    await expect(new DeepSeekApiClient().createSession(AUTH)).rejects.toThrow(
      /biz error 7: rate limited/,
    );
  });

  it("requires a session id", async () => {
    await expect(send({ chatId: undefined })).rejects.toBeInstanceOf(ProviderError);
  });
});
