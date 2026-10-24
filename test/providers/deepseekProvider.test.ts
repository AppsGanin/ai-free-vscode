import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepSeekProvider } from "../../src/providers/deepseek/DeepSeekProvider";
import {
  AuthExpiredError,
  ProviderError,
  type AIStreamChunk,
} from "../../src/providers/types";
import { collect } from "../helpers";

type Step = Error | AIStreamChunk[];

interface Call {
  model: string;
  sessionId?: string;
  parentId?: string;
  maxPromptChars?: number;
}

/**
 * Stands in for DeepSeekApiClient: every request takes the next scripted step
 * — an error to throw, or chunks to stream — and is recorded, so a test can
 * check how the provider recovered (which session, parent, model, budget).
 */
function provider(script: Step[]) {
  const calls: Call[] = [];
  const forgotten: unknown[] = [];
  let sessions = 0;
  let messageId = 100;
  const client = {
    createSession: async () => `s${++sessions}`,
    stopStream: async () => undefined,
    async *sendMessageStream(
      params: { model: string; chatId?: string; parentId?: string },
      _auth: unknown,
      options?: { onMessageId?: (id: number) => void; maxPromptChars?: number },
    ) {
      calls.push({
        model: params.model,
        sessionId: params.chatId,
        parentId: params.parentId,
        maxPromptChars: options?.maxPromptChars,
      });
      const step = script.shift() ?? [{ type: "text", content: "ok" }];
      if (step instanceof Error) throw step;
      options?.onMessageId?.(++messageId);
      yield* step;
    },
  };
  const p = new DeepSeekProvider();
  Object.assign(p as object, {
    apiClient: client,
    authManager: {
      getAuth: async () => ({ token: "t", cookieHeader: "c" }),
      forget: async (_secrets: unknown, auth: unknown) => {
        forgotten.push(auth);
      },
    },
  });
  return { p, calls, forgotten };
}

const secrets = {} as never;
const ask = (p: DeepSeekProvider, text = "hello", model = "deepseek-default") =>
  collect(
    p.sendMessageStream(
      { model, messages: [{ role: "user", content: text }] } as never,
      secrets,
    ),
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("DeepSeek provider recovery", () => {
  it("chains the next turn onto the same session and the last message", async () => {
    const { p, calls } = provider([
      [{ type: "text", content: "first" }],
      [{ type: "text", content: "second" }],
    ]);
    await ask(p);
    await ask(p);
    expect(calls[0]).toMatchObject({ sessionId: "s1", parentId: undefined });
    expect(calls[1]).toMatchObject({ sessionId: "s1", parentId: "101" });
  });

  it("falls back to the default model when Expert is overloaded", async () => {
    const { p, calls } = provider([new ProviderError("x", "expert_busy_use_default")]);
    const out = await ask(p, "hi", "deepseek-expert");
    expect(out.text).toBe("ok");
    expect(calls.map((c) => c.model)).toEqual(["deepseek-expert", "deepseek-default"]);
    expect(calls[1].sessionId).toBe(calls[0].sessionId);
  });

  it("moves to a fresh session while the old one still generates", async () => {
    const { p, calls } = provider([new ProviderError("x", "DeepSeek biz error 11: message still wip")]);
    await ask(p);
    expect(calls.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
  });

  it("moves to a fresh session when the old one was deleted", async () => {
    const { p, calls } = provider([new ProviderError("x", "invalid chat session")]);
    await ask(p);
    expect(calls.map((c) => c.sessionId)).toEqual(["s1", "s2"]);
  });

  it("drops a stale parent message and keeps the session", async () => {
    const { p, calls } = provider([
      [{ type: "text", content: "first" }],
      new ProviderError("x", "DeepSeek biz error 26: invalid message id"),
    ]);
    await ask(p);
    await ask(p);
    expect(calls[1]).toMatchObject({ sessionId: "s1", parentId: "101" });
    expect(calls[2]).toMatchObject({ sessionId: "s1", parentId: undefined });
  });

  it("shrinks the prompt below what was refused for being too long", async () => {
    const long = "x".repeat(40_000);
    const { p, calls } = provider([new ProviderError("x", "Content is too long")]);
    await ask(p, long);
    expect(calls).toHaveLength(2);
    expect(calls[1].maxPromptChars).toBeLessThan(long.length);
  });

  it("waits and retries when the generation slot is busy", async () => {
    vi.useFakeTimers();
    const { p, calls } = provider([new ProviderError("x", "parallel_chat_limit")]);
    const result = ask(p);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await result).text).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("rides out a throttle that lasts most of a minute", async () => {
    // An agent firing turn after turn hits "Messages too frequent"; the
    // window outlasted the old 29 s of retries.
    vi.useFakeTimers();
    const throttled = () => new ProviderError("x", "Messages too frequent. Try again later. (rate_limit_reached)");
    const { p, calls } = provider([throttled(), throttled(), throttled()]);
    const result = ask(p);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await result).text).toBe("ok");
    expect(calls).toHaveLength(4);
  });

  it("spaces requests out for a while after a throttle", async () => {
    vi.useFakeTimers();
    const { p, calls } = provider([
      new ProviderError("x", "Messages too frequent. (rate_limit_reached)"),
    ]);
    // The retry itself is spaced too: 5 s of backoff, then the rest of the
    // 6 s since the throttled request.
    const first = ask(p);
    await vi.advanceTimersByTimeAsync(7_000);
    await first;
    expect(calls).toHaveLength(2);

    const second = ask(p, "next turn");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(2); // still waiting out the spacing
    await vi.advanceTimersByTimeAsync(3_000);
    await second;
    expect(calls).toHaveLength(3);
  });

  it("never retries once part of the answer was shown", async () => {
    const failing: AIStreamChunk[] = [{ type: "text", content: "partial" }];
    const { p, calls } = provider([failing]);
    // Make the first (and only) stream fail after its text.
    const client = (p as unknown as { apiClient: { sendMessageStream: unknown } }).apiClient;
    const original = client.sendMessageStream as (...a: unknown[]) => AsyncIterable<AIStreamChunk>;
    client.sendMessageStream = async function* (...args: unknown[]) {
      yield* original(...args);
      throw new ProviderError("x", "message still wip");
    };
    await expect(ask(p)).rejects.toThrow(/still wip/);
    expect(calls).toHaveLength(1);
  });

  it("does not retry an expired session, and forgets it", async () => {
    const { p, calls, forgotten } = provider([new AuthExpiredError("ai-free-vscode-deepseek")]);
    await expect(ask(p)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(calls).toHaveLength(1);
    // The refused session must not be sent again.
    expect(forgotten).toEqual([{ token: "t", cookieHeader: "c" }]);
  });

  it("keeps the session on a bare 403, which is as often the anti-bot", async () => {
    const { p, forgotten } = provider([new AuthExpiredError("ai-free-vscode-deepseek", 403)]);
    await expect(ask(p)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(forgotten).toEqual([]);
  });
});
