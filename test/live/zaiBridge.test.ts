import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  AuthExpiredError,
  ProviderError,
  RateLimitError,
} from "../../src/providers/types";

/**
 * The Z.ai browser bridge against the real chat.z.ai page, in a throwaway
 * guest profile — no account needed, the user's profile is never touched.
 * The completion endpoint is answered by the test (page.route), so these runs
 * cost no model calls; everything before it — the SPA, the input box, the
 * signing and the invisible captcha — is real.
 */

const PROFILE = mkdtempSync(join(tmpdir(), "zai-bridge-test-"));
vi.mock("../../src/providers/zai/ZaiBrowser", () => ({
  HOME_URL: "https://chat.z.ai",
  browserDataDir: () => PROFILE,
}));

const { ZaiBrowserBridge } = await import("../../src/providers/zai/ZaiBrowserBridge");

type Reply = { status: number; contentType: string; body: string };
let reply: Reply;

const proto = ZaiBrowserBridge.prototype as unknown as {
  openFreshChat: (page: unknown) => Promise<void>;
  goHome: (page: unknown) => Promise<void>;
};
// A guest session is fine here: skip the account check, keep the navigation.
proto.openFreshChat = async function (this: typeof proto, page: unknown) {
  const p = page as {
    __routed?: boolean;
    route: (m: RegExp, h: (r: { fulfill: (o: unknown) => Promise<void> }) => unknown) => Promise<void>;
    waitForSelector: (s: string, o: unknown) => Promise<unknown>;
  };
  if (!p.__routed) {
    p.__routed = true;
    await p.route(/chat\/completions/, (route) =>
      route.fulfill({ status: reply.status, contentType: reply.contentType, body: reply.body }),
    );
  }
  await this.goHome(page);
  await p.waitForSelector("#chat-input", { timeout: 30_000 });
};

const OK: Reply = {
  status: 200,
  contentType: "text/event-stream",
  body:
    'data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"OK"}}\n\n' +
    'data: {"type":"chat:completion","data":{"phase":"done","done":true}}\n\n',
};

const bridge = new ZaiBrowserBridge();

async function sendOnce(prompt = "ping") {
  let text = "";
  for await (const chunk of bridge.streamChat({ model: "glm-4.7", thinking: false, prompt })) {
    text += chunk;
  }
  return text;
}

afterAll(async () => {
  await bridge.close();
  rmSync(PROFILE, { recursive: true, force: true });
});

describe("Z.ai browser bridge (live page, faked completions)", () => {
  it("delivers every message, from a cold start on", async () => {
    // The SPA keeps initialising after the input appears and used to eat the
    // typed text or the Enter — the request then never left.
    reply = OK;
    for (let i = 0; i < 6; i++) {
      expect(await sendOnce(`ping ${i} ${"x".repeat(i * 4000)}`)).toContain("OK");
    }
  });

  it.each([
    [500, "text/plain", "Internal Server Error", ProviderError, /HTTP 500/],
    [401, "application/json", '{"detail":"Not authenticated"}', AuthExpiredError, /expired/],
    [429, "application/json", '{"detail":"Too many"}', RateLimitError, /Rate limit/],
    [200, "text/html", "<html>challenge</html>", ProviderError, /HTTP 200/],
  ])("reports HTTP %d %s as an error, not an empty answer", async (status, contentType, body, type, message) => {
    reply = { status, contentType, body };
    const failure = await sendOnce().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(type);
    expect(String((failure as Error).message)).toMatch(message);
  });

  it("fails a waiting request at once when the browser is closed", async () => {
    // A completion that never answers, then the bridge closes (as Sign In
    // does): the request must not sit out its two-minute timeout.
    reply = OK;
    const pending = (async () => {
      const page = (bridge as unknown as { ensurePage: () => Promise<{ unroute: (m: RegExp) => Promise<void>; route: (m: RegExp, h: () => void) => Promise<void> }> }).ensurePage;
      const p = await page.call(bridge);
      await p.unroute(/chat\/completions/);
      await p.route(/chat\/completions/, () => undefined);
      return sendOnce();
    })();
    const started = Date.now();
    setTimeout(() => void bridge.close(), 12_000);
    await expect(pending).rejects.toThrow(/closed/);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
