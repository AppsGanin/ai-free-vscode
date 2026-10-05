import { afterEach, describe, expect, it, vi } from "vitest";
import { QwenBrowserBridge } from "../../src/providers/qwen/QwenBrowserBridge";

/**
 * The captcha hand-off of the Qwen browser bridge, with the browser itself
 * stubbed out. Each scripted attempt either hits the anti-bot again or gets
 * through and streams.
 */
function bridgeWith(attempts: Array<"blocked" | "passes">) {
  const bridge = new QwenBrowserBridge(() => undefined, "headed");
  const windowLog: string[] = [];
  const fakePage = { isClosed: () => false };

  Object.assign(bridge as object, {
    page: fakePage,
    revealForCaptcha: async () => void windowLog.push("reveal"),
    setWindowBounds: async (_p: unknown, bounds: { windowState?: string }) =>
      void windowLog.push(bounds.windowState ?? "move"),
    ensureLivePage: async () => fakePage,
    // Alibaba's slider has no WAF marker: "cleared" right away, solved or not.
    waitForWafClear: async () => true,
    async *runBrowserStream(_page: unknown, _opts: unknown, state: { wafHit: boolean; yielded: boolean }) {
      const outcome = attempts.shift() ?? "blocked";
      windowLog.push(`attempt:${outcome}`);
      state.wafHit = outcome === "blocked";
      if (outcome === "passes") {
        state.yielded = true;
        yield "data: ok\n\n";
      }
    },
  });
  return { bridge, windowLog };
}

async function solve(bridge: QwenBrowserBridge) {
  const state = { wafHit: true, yielded: false };
  const out: string[] = [];
  const run = (async () => {
    for await (const chunk of (bridge as unknown as {
      solveCaptchaAndRetry: (o: unknown, s: unknown) => AsyncIterable<string>;
    }).solveCaptchaAndRetry({ url: "u", token: "t", body: {} }, state)) {
      out.push(chunk);
    }
  })();
  return { run, out, state };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Qwen captcha hand-off", () => {
  it("keeps the window up until a request really passes", async () => {
    vi.useFakeTimers();
    const { bridge, windowLog } = bridgeWith(["blocked", "blocked", "passes"]);
    const { run, out } = await solve(bridge);
    await vi.advanceTimersByTimeAsync(30_000);
    await run;

    expect(out).toEqual(["data: ok\n\n"]);
    // The window used to be minimised the moment a marker-less captcha
    // appeared, before the user could touch it.
    expect(windowLog).toEqual([
      "reveal",
      "attempt:blocked",
      "attempt:blocked",
      "attempt:passes",
      "minimized",
    ]);
  });

  it("leaves the window open and explains when the captcha is never solved", async () => {
    vi.useFakeTimers();
    const { bridge, windowLog } = bridgeWith([]);
    const { run } = await solve(bridge);
    const failure = run.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(130_000);

    expect(String(await failure)).toMatch(/solve the captcha/);
    expect(windowLog).not.toContain("minimized");
  });
});
