import type { ConsoleMessage, BrowserContext, Page } from "playwright";
import { createLogger, errToString, isDebugEnabled } from "../../logger";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { launchQwenContext } from "./QwenBrowser";

const PROVIDER_ID = "ai-free-vscode-qwen";
const HOME_URL = "https://chat.qwen.ai";
const SINK_BINDING = "__qwenSseSink";
// App headers of the web client (see appHeaders in QwenApiClient).
const WEB_VERSION = "0.2.68";
const BX_V = "2.5.37";

// Timeouts so the bridge fails with a clear error instead of hanging forever.
const LAUNCH_TIMEOUT_MS = 45000;
const NAV_TIMEOUT_MS = 20000;
/** How long the WAF challenge gets to clear itself (cookie + reload). */
const WAF_CLEAR_TIMEOUT_MS = 15000;
/** Wait for the FIRST response; longer means a hostile headless hang. */
const IN_PAGE_FETCH_TIMEOUT_MS = 15000;
/** How long the user gets to solve an interactive captcha. */
const MANUAL_CAPTCHA_TIMEOUT_MS = 120000;
/** Response started but no new stream events for this long — treat as hung. */
const STREAM_IDLE_TIMEOUT_MS = 120000;
const POST_JSON_TIMEOUT_MS = 45000;

const blog = createLogger("qwen-browser");

/**
 * "The chat is in progress!" — upstream is still generating the previous turn.
 * Kept here as well as in QwenApiClient (isChatBusy) so the bridge needs no
 * import from its own consumer.
 */
const CHAT_BUSY = /chat is in progress|CHAT_IN_PROGRESS/i;

type SinkEvent =
  | {
      t: "head";
      status: number;
      contentType: string;
      retryAfter: string | null;
    }
  | { t: "waf" }
  | { t: "chunk"; data: string }
  | { t: "end" }
  | { t: "error"; message: string };

/** wafHit — the answer was an anti-bot challenge; yielded — chunks went out. */
interface RunState {
  wafHit: boolean;
  yielded: boolean;
}

export interface BrowserStreamOptions {
  url: string;
  token: string;
  body: unknown;
  /** Chat page for the Referer header, when the chat_id is known. */
  chatId?: string;
  abortSignal?: AbortSignal;
}

/**
 * Runs Qwen requests through a real browser session, around the Aliyun WAF.
 *
 * The WAF fingerprints the network stack: only Chromium itself gets through,
 * the Node stack is rejected even with a clearance cookie. So requests are made
 * with `page.evaluate` in the context of chat.qwen.ai.
 *
 * The page is hostile to automation and overrides `window.fetch` (a direct
 * fetch used to hang). For buffered JSON we take a clean `fetch` from a fresh
 * same-origin `<iframe>`: untouched by page scripts, same browser stack and
 * cookies.
 *
 * One warm tab; requests are serialised by a mutex (a single active sink).
 */
export class QwenBrowserBridge {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private activeSink: ((ev: SinkEvent) => void) | null = null;
  private mutexChain: Promise<void> = Promise.resolve();

  // "headless" — no window ever; "headed" — a real (minimized) window.
  private mode: "headless" | "headed";
  // Set for "auto": start headless and escalate once if the anti-bot bites.
  private readonly canEscalate: boolean;

  /**
   * @param notifyCaptcha shows the user that a captcha needs solving (the
   * provider forwards it to a VS Code notification).
   */
  constructor(
    private readonly notifyCaptcha?: (message: string) => void,
    configuredMode: "auto" | "headed" | "headless" = "auto",
  ) {
    // Env variables win over the setting.
    const resolved =
      process.env.QWEN_BRIDGE_HEADED === "1"
        ? "headed"
        : process.env.QWEN_BRIDGE_HEADLESS === "1"
          ? "headless"
          : configuredMode;
    this.mode = resolved === "headed" ? "headed" : "headless";
    this.canEscalate = resolved === "auto";
  }

  /**
   * Streams chat/completions through the browser, emitting raw SSE strings —
   * the same shape as a direct response, so the shared parser handles both.
   */
  async *streamChat(opts: BrowserStreamOptions): AsyncIterable<string> {
    const release = await this.acquire();
    try {
      // While nothing has been yielded the request can be safely repeated: both
      // the WAF and the hangs happen before the first chunk.
      const state: RunState = { wafHit: false, yielded: false };

      let blocked = false;
      try {
        yield* this.runBrowserStream(await this.ensurePage(), opts, state);
        blocked = state.wafHit;
      } catch (err) {
        if (state.yielded || !(this.canEscalate && this.mode === "headless")) {
          throw err;
        }
        // A busy chat is upstream state, not a fingerprint verdict: escalating
        // would relaunch Chrome only to be refused again. The API client stops
        // the previous stream and retries — let it see this.
        if (CHAT_BUSY.test(errToString(err))) {
          throw err;
        }
        // In headless the hostile page may hang the fetch; treat that as a block.
        blog.warn(`headless attempt failed: ${errToString(err)}`);
        blocked = true;
      }

      if (blocked && this.canEscalate && this.mode === "headless") {
        blog.info("headless bridge blocked by anti-bot, escalating to headed");
        this.mode = "headed";
        await this.close();
        yield* this.runBrowserStream(await this.ensurePage(), opts, state);
      }

      // Still blocked → one clearance-cookie refresh (it may have expired).
      if (state.wafHit) {
        blog.info("stream hit WAF, re-clearing cookie and retrying once");
        await this.navigateAndClearWaf(this.page as Page, true);
        yield* this.runBrowserStream(this.page as Page, opts, state);
      }

      // Still blocked → interactive captcha.
      if (state.wafHit) {
        yield* this.solveCaptchaAndRetry(opts, state);
      }
    } finally {
      release();
    }
  }

  /** POST with a buffered JSON answer (chat creation) via the browser session. */
  async postJson(
    url: string,
    token: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const release = await this.acquire();
    try {
      const page = await this.ensurePage();
      const runOnce = async () => {
        const result = await withTimeout(
          page.evaluate(BROWSER_JSON_FN, {
            url,
            headers: inPageHeaders(token),
            bodyJson: JSON.stringify(body),
            timeoutMs: IN_PAGE_FETCH_TIMEOUT_MS,
          }),
          POST_JSON_TIMEOUT_MS,
          "postJson",
        );
        blog.debug(`postJson done ok=${result.ok} status=${result.status}`);
        return result;
      };

      let result = await runOnce();
      // The clearance cookie on the warm tab may have expired — clear and retry.
      if (isWafHtml(result.text)) {
        blog.info(
          "postJson hit WAF on warm page, re-clearing and retrying once",
        );
        await this.navigateAndClearWaf(page, true);
        result = await runOnce();
      }

      return isWafHtml(result.text)
        ? { ok: false, status: result.status, text: result.text }
        : result;
    } finally {
      release();
    }
  }

  /** Reads the current Bearer token from the live session (localStorage). */
  async readToken(): Promise<string | undefined> {
    try {
      const page = await this.ensurePage();
      const raw = await page.evaluate(() => {
        const keys = [
          "token",
          "__token",
          "accessToken",
          "access_token",
          "userToken",
        ];
        for (const key of keys) {
          const value = localStorage.getItem(key);
          if (value) return value;
        }
        for (let i = 0; i < localStorage.length; i++) {
          const value = localStorage.getItem(localStorage.key(i) ?? "");
          if (value?.startsWith("eyJ")) return value;
        }
        return null;
      });
      return raw ?? undefined;
    } catch (err) {
      blog.warn(`readToken failed: ${errToString(err)}`);
      return undefined;
    }
  }

  /**
   * Closes the browser. Must be called before an interactive login: a
   * persistent profile cannot be opened by two contexts at once.
   */
  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    this.activeSink = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async *runBrowserStream(
    page: Page,
    opts: BrowserStreamOptions,
    state: RunState,
  ): AsyncIterable<string> {
    state.wafHit = false;
    const events: SinkEvent[] = [];
    let notify: (() => void) | null = null;
    this.activeSink = (ev) => {
      events.push(ev);
      const resume = notify;
      notify = null;
      resume?.();
    };

    const abortInPage = () => {
      page
        .evaluate(() => {
          (window as unknown as { __qwenAbort?: () => void }).__qwenAbort?.();
        })
        .catch(() => undefined);
    };
    if (opts.abortSignal?.aborted) abortInPage();
    else opts.abortSignal?.addEventListener("abort", abortInPage);

    const runPromise = page
      .evaluate(BROWSER_FETCH_FN, {
        url: opts.url,
        headers: {
          ...inPageHeaders(opts.token),
          Referer: opts.chatId
            ? `${HOME_URL}/c/${opts.chatId}`
            : `${HOME_URL}/`,
        },
        bodyJson: JSON.stringify(opts.body),
        sinkName: SINK_BINDING,
        idleTimeoutMs: IN_PAGE_FETCH_TIMEOUT_MS,
      })
      .catch((err) => {
        this.activeSink?.({ t: "error", message: errToString(err) });
      });

    try {
      let finished = false;
      while (!finished) {
        if (events.length === 0) {
          await withTimeout(
            new Promise<void>((resolve) => {
              notify = resolve;
            }),
            STREAM_IDLE_TIMEOUT_MS,
            "stream idle",
          );
        }

        while (events.length > 0) {
          const ev = events.shift() as SinkEvent;
          switch (ev.t) {
            case "head":
              if (ev.status === 401) throw new AuthExpiredError(PROVIDER_ID);
              if (ev.status === 429) {
                throw new RateLimitError(
                  PROVIDER_ID,
                  ev.retryAfter
                    ? parseInt(ev.retryAfter, 10) * 1000
                    : undefined,
                );
              }
              blog.debug(
                `stream head status=${ev.status} contentType=${ev.contentType}`,
              );
              break;
            case "waf":
              // HTML challenge. Stop without throwing: streamChat re-clears the
              // cookie and retries once.
              state.wafHit = true;
              finished = true;
              break;
            case "chunk":
              state.yielded = true;
              yield ev.data;
              break;
            case "end":
              finished = true;
              break;
            case "error":
              throw new ProviderError(PROVIDER_ID, ev.message);
          }
        }
      }
    } finally {
      opts.abortSignal?.removeEventListener("abort", abortInPage);
      // The consumer may have stopped reading early (parser guard) — stop the
      // in-page fetch too, so the upstream is not left running.
      abortInPage();
      this.activeSink = null;
      await runPromise.catch(() => undefined);
    }
  }

  /**
   * Reveals the window, asks for the captcha, waits for the challenge to clear
   * and repeats the request.
   */
  private async *solveCaptchaAndRetry(
    opts: BrowserStreamOptions,
    state: RunState,
  ): AsyncIterable<string> {
    const page = this.page as Page;
    await this.revealForCaptcha();

    if (await this.waitForWafClear(page, MANUAL_CAPTCHA_TIMEOUT_MS)) {
      blog.info("captcha solved by user, retrying request");
      await this.setWindowBounds(page, { windowState: "minimized" });
      yield* this.runBrowserStream(page, opts, state);
    }

    if (state.wafHit) {
      throw new ProviderError(
        PROVIDER_ID,
        "Qwen anti-bot challenge — solve the captcha in the browser window, then send your request again",
      );
    }
  }

  /** Simple mutex: returns the release function, queueing further requests. */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const previous = this.mutexChain;
    this.mutexChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const headless = this.mode === "headless";
    blog.info(`launching browser bridge (mode=${this.mode})`);
    const context = await withTimeout(
      launchQwenContext({
        headless,
        serviceWorkers: "block",
        // A headed window goes off-screen (Linux/Windows); macOS clamps the
        // position, so it is additionally minimized once loaded.
        offscreen: !headless,
      }),
      LAUNCH_TIMEOUT_MS,
      "launch",
    );

    // Stealth: hide automation/headless markers before any page script runs.
    await context.addInitScript(STEALTH_INIT).catch((err) => {
      blog.warn(`addInitScript failed: ${errToString(err)}`);
    });
    context.on("close", () => {
      this.context = undefined;
      this.page = undefined;
    });

    blog.info("browser bridge launched");
    this.context = context;
    return context;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const context = await this.ensureContext();
    const page = await context.newPage();
    watchConsole(page);
    page.on("pageerror", (err) =>
      blog.warn(`[page error] ${errToString(err)}`),
    );
    await page.exposeFunction(SINK_BINDING, (ev: SinkEvent) => {
      this.activeSink?.(ev);
    });

    const cleared = await this.navigateAndClearWaf(page, false);
    this.page = page;

    if (this.mode === "headed") {
      if (cleared) {
        // Challenge gone — hide the window (more reliable than off-screen on
        // macOS; revealForCaptcha brings it back when needed).
        await this.setWindowBounds(page, { windowState: "minimized" });
      } else {
        // Probably an interactive captcha on the page: show it to the user.
        blog.warn("WAF challenge on page did not clear — revealing window");
        await this.revealForCaptcha();
      }
    }
    return page;
  }

  /**
   * Opens/reloads the home page and lets the Aliyun WAF JS challenge run: it
   * computes a clearance cookie and reloads. Without it every later request
   * gets the HTML challenge again.
   */
  private async navigateAndClearWaf(
    page: Page,
    reload: boolean,
  ): Promise<boolean> {
    if (reload) {
      await page
        .reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
    } else {
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    }

    const cleared = await this.waitForWafClear(page, WAF_CLEAR_TIMEOUT_MS);
    blog.info(
      cleared
        ? "bridge page navigated, WAF cleared"
        : "bridge page navigated, but WAF challenge did not clear within timeout",
    );
    return cleared;
  }

  /** Waits for the WAF challenge to disappear; false on timeout. */
  private async waitForWafClear(
    page: Page,
    timeoutMs: number,
  ): Promise<boolean> {
    try {
      await page.waitForFunction(
        () => !document.querySelector('meta[name="aliyun_waf_aa"]'),
        undefined,
        { timeout: timeoutMs },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Brings the hidden bridge window on screen so the captcha can be solved. */
  private async revealForCaptcha(): Promise<void> {
    // From a minimized window: restore to normal first, then place it.
    await this.setWindowBounds(this.page, { windowState: "normal" });
    await this.setWindowBounds(this.page, {
      left: 80,
      top: 80,
      width: 1100,
      height: 820,
    });
    await this.page?.bringToFront().catch(() => undefined);

    this.notifyCaptcha?.(
      "Qwen requires a one-time verification. Solve the captcha in the opened browser window, then send your request again.",
    );
  }

  private async setWindowBounds(
    page: Page | undefined,
    bounds: Record<string, unknown>,
  ): Promise<void> {
    if (!page || !this.context) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds });
    } catch (err) {
      blog.warn(`setWindowBounds failed: ${errToString(err)}`);
    }
  }
}

/**
 * Previews that carry nothing. `console.log(new Error())` reaches us as the
 * bare string "Error", and chat.qwen.ai logs plenty of those — the whole reason
 * the arguments are worth unwrapping.
 */
const OPAQUE_PREVIEW = /^(Error|\{\}|\[object \w+\]|undefined|null|)$/;

/**
 * Mirrors the page console into our channel.
 *
 * Playwright renders each console argument as a preview, which throws away an
 * Error's message. When the preview says nothing, the arguments are unwrapped
 * inside the page to recover the real text. That costs a round-trip per
 * message, so it only happens while DEBUG is on and only for opaque lines.
 */
function watchConsole(page: Page): void {
  page.on("console", (msg) => {
    if (!isDebugEnabled()) return;

    const text = msg.text();
    const type = msg.type();
    const tag = type === "log" ? "[page]" : `[page:${type}]`;

    if (!OPAQUE_PREVIEW.test(text.trim())) {
      blog.debug(`${tag} ${text}`);
      return;
    }

    // Their Errors carry neither message nor stack, so unwrapping alone yields
    // little; the call site is what actually identifies one.
    const where = consoleLocation(msg);

    void describeConsoleArgs(msg)
      .then((detail) => blog.debug(`${tag} ${detail || text || "(empty)"}${where}`))
      // The handles die with the page; a navigation mid-unwrap is normal.
      .catch(() => blog.debug(`${tag} ${text || "(empty)"}${where}`));
  });
}

/** ` @ chunk.js:1:23456` for the console call, when the page reports one. */
function consoleLocation(msg: ConsoleMessage): string {
  const { url, lineNumber, columnNumber } = msg.location();
  return url ? ` @ ${url}:${lineNumber}:${columnNumber}` : "";
}

/** Unwraps console arguments in the page, where Error objects are still whole. */
async function describeConsoleArgs(msg: ConsoleMessage): Promise<string> {
  const parts = await Promise.all(
    msg.args().map((arg) =>
      arg
        .evaluate((value: unknown) => {
          try {
            if (value instanceof Error) {
              const frame = (value.stack ?? "").split("\n")[1] ?? "";
              const where = frame.trim().replace(/^at\s+/, "");
              return `${value.name}: ${value.message || "(no message)"}${
                where ? ` @ ${where}` : ""
              }`;
            }
            if (typeof value === "object" && value !== null) {
              return JSON.stringify(value).slice(0, 300);
            }
            return String(value);
          } catch {
            return Object.prototype.toString.call(value);
          }
        })
        .catch(() => ""),
    ),
  );

  return parts.filter(Boolean).join(" ").slice(0, 500);
}

/** Headers for the in-page fetch; built here so both helpers stay identical. */
function inPageHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    source: "web",
    version: WEB_VERSION,
    "bx-v": BX_V,
    "x-request-id": crypto.randomUUID(),
    timezone: new Date().toString().replace(/\s*\(.*\)\s*$/, ""),
  };
}

/** Does the body look like an Aliyun WAF challenge instead of API data? */
function isWafHtml(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return head.includes("aliyun_waf") || head.includes("<!doctype");
}

/** Rejects with a ProviderError after `ms`; the promise itself keeps running. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProviderError(
            PROVIDER_ID,
            `browser bridge timeout: ${label} (${ms}ms)`,
          ),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stealth script (context.addInitScript): hides the usual automation/headless
 * markers so the anti-bot trusts the session. Runs in every document before the
 * page's own scripts.
 */
const STEALTH_INIT = () => {
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

/**
 * Runs INSIDE the page (serialized by Playwright, executed through CDP, so the
 * CSP does not apply). Streams SSE back to Node through the exposed binding.
 * Uses the main page's `window.fetch` on purpose: completions must run in the
 * trusted session/anti-bot SDK context, otherwise it answers x5sec/RGV587.
 */
const BROWSER_FETCH_FN = async (args: {
  url: string;
  headers: Record<string, string>;
  bodyJson: string;
  sinkName: string;
  idleTimeoutMs: number;
}): Promise<void> => {
  const w = window as unknown as Record<string, unknown>;
  const sink = w[args.sinkName] as (ev: SinkEvent) => Promise<void>;
  const readText = async (resp: Response) => {
    try {
      return await resp.text();
    } catch {
      return "";
    }
  };

  const controller = new AbortController();
  // The timer only guards the wait for headers; it is cleared afterwards.
  let waitTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    args.idleTimeoutMs,
  );
  w.__qwenAbort = () => controller.abort();

  let resp: Response;
  try {
    resp = await window.fetch(args.url, {
      method: "POST",
      headers: args.headers,
      body: args.bodyJson,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(waitTimer);
    await sink({ t: "error", message: String((e as Error)?.message ?? e) });
    return;
  }
  clearTimeout(waitTimer);
  waitTimer = undefined;

  const contentType = resp.headers.get("content-type") ?? "";
  await sink({
    t: "head",
    status: resp.status,
    contentType,
    retryAfter: resp.headers.get("retry-after"),
  });

  // completions must return SSE. Anything else is the WAF or an anti-bot (html,
  // or x5sec/RGV587 in JSON). Signal 'waf' so the caller re-clears and retries.
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await readText(resp);
    if (
      contentType.toLowerCase().includes("text/html") ||
      /FAIL_SYS_USER_VALIDATE|RGV587|x5sec|_____tmd_____|\/punish/i.test(text)
    ) {
      await sink({ t: "waf" });
    } else {
      await sink({
        t: "error",
        message: "Non-SSE " + resp.status + ": " + text.slice(0, 300),
      });
    }
    return;
  }

  if (!resp.ok) {
    const text = await readText(resp);
    await sink({
      t: "error",
      message: "HTTP " + resp.status + ": " + text.slice(0, 300),
    });
    return;
  }

  if (!resp.body) {
    const text = await readText(resp);
    if (text) await sink({ t: "chunk", data: text });
    await sink({ t: "end" });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) {
        await sink({
          t: "chunk",
          data: decoder.decode(value, { stream: true }),
        });
      }
    }
    const tail = decoder.decode();
    if (tail) await sink({ t: "chunk", data: tail });
    await sink({ t: "end" });
  } catch (e) {
    await sink({ t: "error", message: String((e as Error)?.message ?? e) });
  }
};

/** In-page POST with a buffered JSON answer, using a clean iframe fetch. */
const BROWSER_JSON_FN = async (args: {
  url: string;
  headers: Record<string, string>;
  bodyJson: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; status: number; text: string }> => {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = "about:blank";
  document.documentElement.appendChild(frame);

  const cw = frame.contentWindow as (Window & typeof globalThis) | null;
  const cleanFetch = (cw?.fetch ?? window.fetch).bind(cw ?? window);
  const CleanAbort = cw?.AbortController ?? AbortController;

  const controller = new CleanAbort();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const resp = await cleanFetch(args.url, {
      method: "POST",
      headers: args.headers,
      body: args.bodyJson,
      credentials: "include",
      signal: controller.signal,
    });
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
    try {
      frame.remove();
    } catch {
      /* ignore */
    }
  }
};
