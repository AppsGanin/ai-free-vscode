import type { BrowserContext, Page } from "playwright";

/**
 * Stealth script (context.addInitScript): hides the usual automation/headless
 * markers so the anti-bot trusts the session. Runs in every document before the
 * page's own scripts.
 */
export const STEALTH_INIT = () => {
  const def = (obj: object, prop: string, value: unknown) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value });
    } catch {
      /* ignore */
    }
  };

  const nav = navigator as unknown as Record<string, unknown>;
  def(nav, "webdriver", undefined);
  def(nav, "hardwareConcurrency", 8);
  def(nav, "deviceMemory", 8);
  def(nav, "languages", ["en-US", "en"]);
  // A non-empty plugin list (headless has none — a dead giveaway).
  def(nav, "plugins", [1, 2, 3, 4, 5]);

  const w = window as unknown as Record<string, unknown>;
  w.chrome ??= { runtime: {} };

  // In headless, permissions.query for notifications disagrees with Notification.
  try {
    const perms = navigator.permissions as unknown as {
      query?: (d: { name: string }) => Promise<unknown>;
    };
    const orig = perms?.query?.bind(perms);
    if (orig) {
      perms.query = (d: { name: string }) =>
        d?.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : orig(d);
    }
  } catch {
    /* ignore */
  }

  // WebGL vendor/renderer — headless often reports SwiftShader/Google.
  try {
    const proto = WebGLRenderingContext.prototype as unknown as {
      getParameter: (p: number) => unknown;
    };
    const getParam = proto.getParameter;
    proto.getParameter = function (this: unknown, p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParam.call(this, p);
    };
  } catch {
    /* ignore */
  }
};

const UA_PLATFORM: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * Headless Chrome announces itself in the User-Agent ("HeadlessChrome/…") and
 * in the Client Hints brands. Rewrites both, for every page of the context,
 * to what the same Chrome sends headed.
 */
export async function maskHeadless(context: BrowserContext): Promise<void> {
  const apply = async (page: Page) => {
    try {
      const ua = await page.evaluate(() => navigator.userAgent);
      if (!/HeadlessChrome/.test(ua)) return;
      const full = /HeadlessChrome\/([\d.]+)/.exec(ua)?.[1] ?? "0.0.0.0";
      const major = full.split(".")[0];
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent: ua.replace("HeadlessChrome", "Chrome"),
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not=A?Brand", version: "24" },
          ],
          fullVersion: full,
          platform: UA_PLATFORM[process.platform] ?? "Windows",
          platformVersion: "10.15.7",
          architecture: process.arch === "arm64" ? "arm" : "x86",
          model: "",
          mobile: false,
        },
      });
    } catch {
      /* best effort */
    }
  };
  for (const page of context.pages()) await apply(page);
  context.on("page", (page) => void apply(page));
}
