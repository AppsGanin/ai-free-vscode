import { afterEach, describe, expect, it, vi } from "vitest";
import { QwenApiClient } from "../../src/providers/qwen/QwenApiClient";
import type { QwenBrowserBridge } from "../../src/providers/qwen/QwenBrowserBridge";
import { resetWebVersion, webVersion } from "../../src/providers/qwen/QwenWebVersion";
import { collect, sse } from "../helpers";

const answer = (content: string) => ({
  choices: [{ delta: { role: "assistant", content, phase: "answer" } }],
});

type Reply = Response | Error;

/**
 * fetch over per-endpoint queues of replies: each call to an endpoint takes
 * the next one (the last repeats). Lets a test script a failure, then the
 * recovery.
 */
function scriptFetch(script: { chats?: Reply[]; completions: Reply[]; stop?: Reply[] }) {
  const calls: string[] = [];
  let chat = 0;
  const take = (queue: Reply[] | undefined, fallback: () => Reply) => {
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0] ?? fallback();
    return next;
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      let reply: Reply;
      if (url === "https://chat.qwen.ai/") {
        reply = new Response('<script src="//assets.alicdn.com/g/qwenweb/qwen-chat-fe/9.9.9/js/main.js">');
      } else if (url.includes("/chats/new")) {
        calls.push("chats/new");
        reply = take(script.chats, () => json({ success: true, data: { id: `chat-${++chat}` } }));
      } else if (url.includes("/completions/stop")) {
        calls.push("stop");
        reply = take(script.stop, () => json({ success: true }));
      } else {
        calls.push(`completions ${new URL(url).searchParams.get("chat_id")}`);
        reply = take(script.completions, () => new Response("", { status: 599 }));
      }
      if (reply instanceof Error) throw reply;
      return reply.clone();
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (...records: unknown[]) =>
  new Response(sse(...records), { headers: { "content-type": "text/event-stream" } });

const send = (client = new QwenApiClient(), onChatIdChanged?: (id: string) => void) =>
  collect(
    client.sendMessageStream(
      { model: "qwen3.8-max", messages: [{ role: "user", content: "hi" }] } as never,
      "tok",
      onChatIdChanged,
    ),
  );

afterEach(() => {
  resetWebVersion();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Qwen recovery", () => {
  it("stops a busy chat and retries in it", async () => {
    vi.useFakeTimers();
    const calls = scriptFetch({
      completions: [
        json({ success: false, data: { code: "Bad_Request", details: "The chat is in progress!" } }),
        stream(answer("ok")),
      ],
    });
    const result = send();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await result).text).toBe("ok");
    expect(calls).toEqual(["chats/new", "completions chat-1", "stop", "completions chat-1"]);
  });

  it("moves to a new chat after a dropped connection", async () => {
    const changed: string[] = [];
    const calls = scriptFetch({
      completions: [new TypeError("fetch failed"), stream(answer("ok"))],
    });
    const out = await send(new QwenApiClient(), (id) => changed.push(id));
    expect(out.text).toBe("ok");
    expect(calls).toEqual(["chats/new", "completions chat-1", "chats/new", "completions chat-2"]);
    // The provider caches chat ids per conversation and must learn the new one.
    expect(changed).toEqual(["chat-2"]);
  });

  it("re-reads the web version and moves to a new chat after an internal error", async () => {
    const calls = scriptFetch({
      completions: [
        json({ success: false, data: { code: "Bad_Request", details: "Internal error..." } }),
        stream(answer("ok")),
      ],
    });
    const fetchMock = vi.mocked(fetch);
    expect((await send()).text).toBe("ok");
    expect(calls).toEqual(["chats/new", "completions chat-1", "chats/new", "completions chat-2"]);
    expect(webVersion()).toBe("9.9.9");
    const versions = fetchMock.mock.calls
      .filter(([url]) => String(url).includes("/completions"))
      .map(([, init]) => (init?.headers as Record<string, string>).version);
    expect(versions).toEqual(["9.9.9", "9.9.9"]);
  });

  it("falls back to the browser session when the WAF blocks the direct stream", async () => {
    scriptFetch({
      completions: [
        new Response("<!doctype html><meta name=aliyun_waf_aa>", {
          headers: { "content-type": "text/html" },
        }),
      ],
    });
    const browser = {
      async *streamChat() {
        yield sse(answer("via "), answer("browser"));
      },
    } as unknown as QwenBrowserBridge;
    expect((await send(new QwenApiClient(browser))).text).toBe("via browser");
  });

  it("does not retry once the answer has started", async () => {
    const calls = scriptFetch({
      completions: [stream(answer("partial"), { error: { code: "boom" }, details: "x" })],
    });
    const out = await send();
    // An error after content is Qwen dropping the stream at the end.
    expect(out.text).toBe("partial");
    expect(calls.filter((c) => c.startsWith("completions"))).toHaveLength(1);
  });
});
