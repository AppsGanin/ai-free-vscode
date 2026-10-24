import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiApiClient } from "../../src/providers/kimi/KimiApiClient";
import { resetChatTargets } from "../../src/providers/kimi/KimiChatModel";
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
        model: "kimi-instant",
        messages: [{ role: "user", content: "hi" }],
        ...params,
      } as never,
      auth,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatTargets();
});

/** The chat requests only: the model list is read first. */
const chats = (requests: { url: string }[]) => requests.filter((r) => CHAT.test(r.url));

const MODELS = /ConfigService\/GetAvailableModels/;
const modelList = {
  match: MODELS,
  contentType: "application/json",
  body: JSON.stringify({
    defaultChatModel: "k2d6-chat",
    availableModels: [
      { id: "k3-agent", scenario: "SCENARIO_OK_COMPUTER" },
      { id: "k2d6-chat", scenario: "SCENARIO_CHAT" },
    ],
  }),
};

/** Connect body of a recorded request, decoded. */
function sentPayload(request: { body: unknown }): { scenario: string; options: Record<string, unknown>; message: { blocks: { text: { content: string } }[] } } {
  const bytes = new Uint8Array(request.body as ArrayBuffer);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(5)));
}

const serverTool = (name: string) => ({
  op: "set",
  block: { id: "1", tool: { toolCallId: `${name}_0`, name, status: "STATUS_PENDING" } },
});
const VIEW = { name: "view", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } };

describe("Kimi client", () => {
  it("chats with the plain chat model the web app offers, not an agent scenario", async () => {
    const requests = mockFetch([modelList, { match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) }]);
    await send();
    await send();
    const payload = sentPayload(chats(requests)[0]);
    expect(payload.scenario).toBe("SCENARIO_CHAT");
    expect(payload.options.model).toBe("k2d6-chat");
    // Read once, then cached.
    expect(requests.filter((r) => MODELS.test(r.url))).toHaveLength(1);
  });

  it("falls back to the legacy scenario when the model list cannot be read", async () => {
    const requests = mockFetch([{ match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) }]);
    await send();
    const payload = sentPayload(chats(requests)[0]);
    expect(payload.scenario).toBe("SCENARIO_K2D5");
    expect(payload.options.model).toBeUndefined();
  });

  it("cuts a turn that reaches for Kimi's own tools and asks again with a reminder", async () => {
    let call = 0;
    const call1 = frames(serverTool("ipython"));
    const call2 = frames(text('```tool_call\n{"name":"view","arguments":{"path":"a.ts"}}\n```'));
    const requests = mockFetch([
      modelList,
      { match: CHAT, contentType: "application/connect+json", body: () => new TextDecoder().decode(call++ === 0 ? call1 : call2) },
    ]);
    const out = await send({ tools: [VIEW] });
    expect(out.calls.map((c) => c.name)).toEqual(["view"]);
    const sent = chats(requests).map((r) => sentPayload(r).message.blocks[0].text.content);
    expect(sent).toHaveLength(2);
    expect(sent[0]).not.toContain("built-in tools");
    expect(sent[1]).toContain("built-in tools (ipython, shell");
  });

  it("gives up when every attempt reaches for Kimi's own tools", async () => {
    mockFetch([modelList, { match: CHAT, contentType: "application/connect+json", body: frames(serverTool("shell")) }]);
    await expect(send({ tools: [VIEW] })).rejects.toThrow(/own server-side shell/);
  });

  it("ends the turn on its text instead of repeating what was shown", async () => {
    // Long enough to leave the router's look-ahead, so the user has seen it.
    const shown = "Сейчас посмотрю файл и всё проверю. ".repeat(20);
    const requests = mockFetch([
      modelList,
      { match: CHAT, contentType: "application/connect+json", body: frames(text(shown), serverTool("ipython")) },
    ]);
    const out = await send({ tools: [VIEW] });
    expect(out.text.length).toBeGreaterThan(0);
    expect(shown.startsWith(out.text)).toBe(true);
    expect(chats(requests)).toHaveLength(1);
  });

  it("hands Kimi's own shell call to the caller's command tool", async () => {
    const RUN = {
      name: "run_in_terminal",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" }, explanation: { type: "string" }, isBackground: { type: "boolean" } },
        required: ["command", "explanation", "isBackground"],
      },
    };
    const requests = mockFetch([
      modelList,
      {
        match: CHAT,
        contentType: "application/connect+json",
        body: frames(
          serverTool("shell"),
          { op: "append", mask: "block.tool.args", block: { id: "1", tool: { args: '{"command":"npm' } } },
          { op: "append", mask: "block.tool.args", block: { id: "1", tool: { args: ' test"}' } } },
          { op: "set", block: { id: "1", tool: { args: '{"command":"npm test"}', status: "STATUS_RUNNING" } } },
        ),
      },
    ]);
    const out = await send({ tools: [VIEW, RUN] });
    expect(out.calls).toEqual([
      { name: "run_in_terminal", args: { command: "npm test", explanation: "Run the command the model asked for", isBackground: false } },
    ]);
    // Handed over, not asked again.
    expect(chats(requests)).toHaveLength(1);
  });

  it("runs Kimi's ipython code through the caller's shell, unless it works on Kimi's own files", async () => {
    const { translateServerCall } = await import("../../src/providers/kimi/KimiApiClient");
    const BASH = { name: "bash", description: "", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
    const call = translateServerCall("ipython", JSON.stringify({ code: "print(6*7)" }), [BASH]);
    expect(call).toMatchObject({ type: "tool_call", name: "bash" });
    expect(JSON.parse((call as { argumentsPart: string }).argumentsPart).command).toBe("python3 - <<'PY'\nprint(6*7)\nPY");
    expect(translateServerCall("ipython", JSON.stringify({ code: "open('/mnt/data/x.csv')" }), [BASH])).toBeUndefined();
    expect(translateServerCall("browser_click", "{}", [BASH])).toBeUndefined();
    expect(translateServerCall("shell", JSON.stringify({ command: "ls" }), [VIEW])).toBeUndefined();
  });

  it("lets Kimi's own tools run in a chat without the caller's tools", async () => {
    mockFetch([
      modelList,
      { match: CHAT, contentType: "application/connect+json", body: frames(serverTool("ipython"), text("121932631112635269")) },
    ]);
    expect((await send()).text).toBe("121932631112635269");
  });

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
    expect(chats(requests)[0].headers.authorization).toBe("Bearer eyJ.kimi");
    expect(chats(requests)[0].headers["content-type"]).toBe("application/connect+json");
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
    expect(chats(requests)[0].url.startsWith(`${origin}/apiv2/`)).toBe(true);
    expect(chats(requests)[0].headers.origin).toBe(origin);
  });

  it("keeps sessions stored before regions existed on kimi.com", async () => {
    const requests = mockFetch([
      { match: CHAT, contentType: "application/connect+json", body: frames(text("ok")) },
    ]);
    await send({}, { token: "eyJ.kimi" });
    expect(chats(requests)[0].url.startsWith("https://www.kimi.com/")).toBe(true);
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
