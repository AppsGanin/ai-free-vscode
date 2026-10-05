import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiApiClient } from "../../src/providers/kimi/KimiApiClient";
import { AuthExpiredError, ProviderError } from "../../src/providers/types";
import { collect, mockFetch } from "../helpers";

/** Connect protocol: 1 flag byte, 4-byte big-endian length, JSON payload. */
function frames(...payloads: unknown[]): Uint8Array {
  const parts = payloads.map((payload) => {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(5 + json.length);
    new DataView(frame.buffer).setUint32(1, json.length, false);
    frame.set(json, 5);
    return frame;
  });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const text = (content: string) => ({ op: "append", block: { text: { content } } });
const thinking = (content: string) => ({
  op: "append",
  block: { thinking: { content } },
});

const CHAT = /kimi\.gateway\.chat\.v1\.ChatService\/Chat/;

function send(
  params: Record<string, unknown> = {},
  auth: { token: string; origin?: string } = { token: "eyJ.kimi", origin: "https://www.kimi.ai" },
) {
  return collect(
    new KimiApiClient().sendMessageStream(
      {
        model: "kimi-k2.5",
        messages: [{ role: "user", content: "hi" }],
        ...params,
      } as never,
      auth,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kimi client", () => {
  it("decodes Connect frames into reasoning and answer", async () => {
    mockFetch([
      {
        match: CHAT,
        contentType: "application/connect+json",
        // 3-byte pieces split frame headers and multi-byte characters alike.
        chunkSize: 3,
        body: frames(
          { heartbeat: {} },
          thinking("Думаю"),
          text("При"),
          text("вет!"),
          { op: "set", done: {} },
        ),
      },
    ]);
    const out = await send({ thinkingMode: "on" });
    expect(out.thinking).toBe("Думаю");
    expect(out.text).toBe("Привет!");
  });

  it("sends the whole conversation as one Connect-framed turn", async () => {
    const requests = mockFetch([
      { match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) },
    ]);
    await send({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
    });
    expect(requests[0].headers.authorization).toBe("Bearer eyJ.kimi");
    expect(requests[0].headers["content-type"]).toBe("application/connect+json");
  });

  it.each([
    ["global account", "https://www.kimi.ai"],
    ["China account", "https://www.kimi.com"],
  ])("talks to the region the %s signed in on", async (_label, origin) => {
    // kimi.ai and kimi.com are separate services: a token from one is refused
    // by the other.
    const requests = mockFetch([
      { match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) },
    ]);
    await send({}, { token: "eyJ.kimi", origin });
    expect(requests[0].url.startsWith(`${origin}/apiv2/`)).toBe(true);
    expect(requests[0].headers.origin).toBe(origin);
  });

  it("keeps sessions stored before regions existed on kimi.com", async () => {
    const requests = mockFetch([
      { match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) },
    ]);
    await send({}, { token: "eyJ.kimi" });
    expect(requests[0].url.startsWith("https://www.kimi.com/")).toBe(true);
  });

  it("turns the text tool protocol into a tool call", async () => {
    mockFetch([
      {
        match: CHAT,
        contentType: "application/connect+json",
        body: frames(
          text("```tool_call\n"),
          text('{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```'),
        ),
      },
    ]);
    const out = await send({
      tools: [{ name: "read_file", description: "", parameters: { type: "object", properties: {} } }],
      toolMode: "auto",
    });
    expect(out.calls).toEqual([{ name: "read_file", args: { filePath: "a.ts" } }]);
  });

  it("reports an error frame", async () => {
    mockFetch([
      {
        match: CHAT,
        contentType: "application/connect+json",
        body: frames({ error: { message: "quota exceeded" } }),
      },
    ]);
    await expect(send()).rejects.toThrow(/quota exceeded/);
  });

  it("maps 401 to an expired session", async () => {
    mockFetch([{ match: CHAT, status: 401, contentType: "application/json", body: "{}" }]);
    await expect(send()).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it("reports other HTTP failures", async () => {
    mockFetch([{ match: CHAT, status: 500, contentType: "text/plain", body: "boom" }]);
    await expect(send()).rejects.toBeInstanceOf(ProviderError);
  });
});
