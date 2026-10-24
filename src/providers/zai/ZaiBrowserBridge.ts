import type { BrowserContext, Page } from "playwright";
import { createLogger, errToString } from "../../logger";
import { launchPersistentProfile } from "../common/browserAuth";
import { maskHeadless, STEALTH_INIT } from "../common/stealth";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { sessionKind } from "./ZaiAuthManager";
import { ZaiRequestGate } from "./ZaiRequestGate";
import { browserDataDir, HOME_URL } from "./ZaiBrowser";

const PROVIDER_ID = "ai-free-vscode-zai";
const SINK_BINDING = "__zaiSink";
const OVERRIDE_KEY = "__zaiOverride";
const INPUT_SELECTOR = "#chat-input";

const LAUNCH_TIMEOUT_MS = 45000;
const NAV_TIMEOUT_MS = 30000;
/** From Enter to the request leaving the page; longer means something is in the way. */
const SEND_TIMEOUT_MS = 25000;
/** How often the send watchdog looks at the page. */
const SEND_POLL_MS = 500;
/** An Enter the page has not reacted to by now is repeated. */
const RESEND_AFTER_MS = 3000;
/** Enter presses per request, the first one included. */
const MAX_SEND_ATTEMPTS = 4;
/** How long the user gets to deal with a verification shown in the window. */
const MANUAL_CAPTCHA_TIMEOUT_MS = 120000;
/** Response started but nothing new for this long — treat as hung. */
const STREAM_IDLE_TIMEOUT_MS = 120000;
const DELETE_CHAT_TIMEOUT_MS = 5000;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  // The window lives off-screen/minimized; without these Chrome throttles its
  // timers and the stream arrives in bursts.
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
const OFFSCREEN_ARGS = ["--window-position=-32000,-32000"];

/** A headless attempt the anti-bot did not let through (see "auto" mode). */
class HeadlessBlockedError extends Error {}

const blog = createLogger("zai-browser");

type SinkEvent =
  | { t: "request"; chatId: string | null }
  | { t: "head"; status: number; contentType: string }
  | { t: "chunk"; data: string }
  | { t: "end" }
  | { t: "error"; message: string };

export interface ZaiBrowserRequest {
  /** Upstream model id (see upstreamZaiModelId). */
  model: string;
  thinking: boolean;
  /** The whole conversation as one message. */
  prompt: string;
  abortSignal?: AbortSignal;
}

/**
 * Sends Z.ai messages through the web app itself, in a real Chrome.
 *
 * chat.z.ai signs every completion request and runs an invisible captcha
 * before it, both inside its own frontend. Rather than reproduce either, the
 * bridge types the prompt into the chat box and lets the page send it; an init
 * script wraps `fetch` to set the model and thinking mode on the way out and
 * to copy the SSE answer to us. Should the captcha turn interactive, the window
 * is brought on screen for the user to solve — the bridge never answers it.
 *
 * One warm tab; requests are serialised by a mutex.
 */
export class ZaiBrowserBridge {
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private page: Page | undefined;
  private activeSink: ((ev: SinkEvent) => void) | null = null;
  private mutexChain: Promise<void> = Promise.resolve();
  /** Request pacing and the pause after a WAF block (see ZaiRequestGate). */
  private readonly gate = new ZaiRequestGate();

  // "headless" — no window ever; "headed" — a real (off-screen, minimized) window.
  private mode: "headless" | "headed";
  // Set for "auto": start headless and escalate once if the anti-bot bites.
  private readonly canEscalate: boolean;

  constructor(
    private readonly notifyCaptcha?: (message: string) => void,
    configuredMode: "auto" | "headed" | "headless" = "auto",
  ) {
    // Env variables win over the setting.
    const resolved =
      process.env.ZAI_BRIDGE_HEADED === "1"
        ? "headed"
        : process.env.ZAI_BRIDGE_HEADLESS === "1"
          ? "headless"
          : configuredMode;
    this.mode = resolved === "headless" || resolved === "auto" ? "headless" : "headed";
    this.canEscalate = resolved === "auto";
  }

  /**
   * Streams the raw SSE text of one answer.
   *
   * Mode (freeAI.zai.browserMode): in headless Chrome the page's invisible
   * Alibaba captcha may escalate to an interactive puzzle (`/qst/PUZZLE/`), so
   * the message is never sent. "auto" starts headless and, if the message is
   * not sent, relaunches once as a real (off-screen, minimized) window, where
   * the puzzle can also be shown to the user.
   */
  async *streamChat(req: ZaiBrowserRequest): AsyncIterable<string> {
    const release = await this.acquire();
    try {
      await this.gate.beforeRequest(req.abortSignal);
      try {
        yield* this.attempt(req);
      } catch (err) {
        if (!(err instanceof HeadlessBlockedError)) throw err;
        // Nothing was yielded yet (the message never left), so a retry is safe.
        blog.info("headless bridge blocked by anti-bot, escalating to headed");
        this.mode = "headed";
        await this.close();
        yield* this.attempt(req);
      }
    } finally {
      release();
    }
  }

  /** One send-and-stream in the current browser mode. */
  private async *attempt(req: ZaiBrowserRequest): AsyncIterable<string> {
    let chatId: string | null = null;
    try {
      const page = await this.ensurePage();
      await this.openFreshChat(page);

      const events = new EventQueue();
      this.activeSink = (ev) => events.push(ev);

      await page.evaluate(
        ([key, value]) => {
          (window as unknown as Record<string, unknown>)[key as string] = value;
        },
        [OVERRIDE_KEY, { model: req.model, thinking: req.thinking }] as const,
      );
      const first = await this.submit(page, req.prompt, events, req.abortSignal);
      if (!first) return;
      chatId = first.chatId;

      // An error answer (HTTP error, or a body that is not SSE) is collected
      // whole and thrown — passed on as SSE it would parse to nothing and
      // look like an empty reply.
      let failure: { status: number; body: string } | undefined;

      for (;;) {
        const ev = await events.next(STREAM_IDLE_TIMEOUT_MS, req.abortSignal);
        if (!ev) {
          if (req.abortSignal?.aborted) {
            blog.debug("stream aborted by caller");
            await this.stopPage(page);
            return;
          }
          throw new ProviderError(PROVIDER_ID, "Z.ai stream timeout");
        }
        if (ev.t === "head") {
          blog.debug(`response status=${ev.status} type=${ev.contentType}`);
          if (ev.status >= 400 || !/event-stream/i.test(ev.contentType)) {
            failure = { status: ev.status, body: "" };
          }
          continue;
        }
        if (ev.t === "chunk") {
          if (failure) {
            failure.body += ev.data;
            continue;
          }
          yield ev.data;
          continue;
        }
        if (ev.t === "error") {
          throw new ProviderError(PROVIDER_ID, `Z.ai: ${ev.message}`);
        }
        if (ev.t === "end") {
          if (failure) {
            if (isWafBlockPage(failure.status, failure.body)) {
              this.gate.blocked();
              blog.warn(
                `WAF block on the completion endpoint — pausing Z.ai requests for ${Math.round(this.gate.pausedFor / 60_000)} min`,
              );
            }
            throw httpError(failure.status, failure.body);
          }
          this.gate.passed();
          return;
        }
      }
    } finally {
      this.activeSink = null;
      await this.deleteChat(chatId);
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    await context?.close().catch(() => undefined);
  }

  /**
   * Types the prompt, presses Enter and makes sure the page actually sends it.
   *
   * The app is a SPA that keeps initialising after the input shows up: a late
   * internal navigation can wipe what was typed, and an Enter that lands in
   * that moment does nothing. So the page is watched until the request leaves:
   * - text still in the box → the Enter was lost, press it again;
   * - box empty but still on the home page → the text was wiped, type again;
   * - the app created the chat (`/chats/new`) or moved to it (`/c/…`) → the
   *   message was accepted and the captcha is running; wait, never press
   *   again — that would send it twice. The box alone cannot tell: the app
   *   empties it on accepting, just as a wipe does.
   * Still nothing after SEND_TIMEOUT_MS usually means a verification dialog:
   * the window is shown and the user gets time to deal with it.
   */
  private async submit(
    page: Page,
    prompt: string,
    events: EventQueue,
    signal?: AbortSignal,
  ): Promise<{ chatId: string | null } | undefined> {
    let chatCreated = false;
    const onRequest = (request: { url(): string }) => {
      if (/\/api\/v\d+\/chats\/new(\?|$)/.test(request.url())) chatCreated = true;
    };
    page.on("request", onRequest);
    try {
      return await this.submitWatched(page, prompt, events, () => chatCreated, signal);
    } finally {
      page.off("request", onRequest);
    }
  }

  private async submitWatched(
    page: Page,
    prompt: string,
    events: EventQueue,
    chatCreated: () => boolean,
    signal?: AbortSignal,
  ): Promise<{ chatId: string | null } | undefined> {
    await this.typePrompt(page, prompt);
    await page.keyboard.press("Enter");
    blog.debug(`prompt submitted (${prompt.length} chars)`);

    const deadline = Date.now() + SEND_TIMEOUT_MS;
    let attempts = 1;
    let lastPress = Date.now();
    let ev: Extract<SinkEvent, { t: "request" }> | undefined;

    while (!ev && !signal?.aborted && Date.now() < deadline) {
      ev = await events.nextOf("request", SEND_POLL_MS, signal);
      if (ev || signal?.aborted) break;
      if (Date.now() - lastPress < RESEND_AFTER_MS) continue;
      if (attempts >= MAX_SEND_ATTEMPTS) continue;

      const state = await this.composerState(page);
      if (state.accepted || chatCreated()) continue;

      attempts++;
      lastPress = Date.now();
      if (state.typed === 0) {
        blog.debug(`input was cleared before sending — typing again (attempt ${attempts})`);
        await this.typePrompt(page, prompt);
      } else {
        blog.debug(`Enter had no effect — pressing again (attempt ${attempts})`);
        await page.focus(INPUT_SELECTOR).catch(() => undefined);
      }
      await page.keyboard.press("Enter");
    }

    if (!ev && !signal?.aborted && this.mode === "headless") {
      if (this.canEscalate) throw new HeadlessBlockedError();
      throw new ProviderError(
        PROVIDER_ID,
        "Z.ai: the message was not sent in headless mode (the anti-bot probably wants a verification) — set freeAI.zai.browserMode to auto or headed",
      );
    }
    if (!ev && !signal?.aborted) {
      blog.warn("message not sent within timeout — revealing window");
      await this.reveal(page);
      this.notifyCaptcha?.(
        "Z.ai needs a verification. Complete it in the opened browser window — your request continues by itself.",
      );
      try {
        ev = await events.nextOf("request", MANUAL_CAPTCHA_TIMEOUT_MS, signal);
      } finally {
        // Verification passed (or abandoned): hide the window again.
        blog.info("verification step finished — hiding the window");
        await this.minimize(page);
      }
    }
    if (ev && attempts > 1) blog.info(`message sent on attempt ${attempts}`);
    if (ev) return { chatId: ev.chatId };
    if (signal?.aborted) {
      await this.stopPage(page);
      return undefined;
    }
    throw new ProviderError(
      PROVIDER_ID,
      "Z.ai: the message was not sent (verification not completed, or the web app changed)",
    );
  }

  /** What the page did with the last Enter (see submit). */
  private async composerState(
    page: Page,
  ): Promise<{ typed: number; accepted: boolean }> {
    try {
      return await page.evaluate((selector: string) => {
        const el = document.querySelector(selector);
        const typed =
          el instanceof HTMLTextAreaElement
            ? el.value.length
            : (el?.textContent ?? "").length;
        return { typed, accepted: location.pathname.startsWith("/c/") };
      }, INPUT_SELECTOR);
    } catch {
      // Mid-navigation: nothing to judge by, so do nothing this round.
      return { typed: 1, accepted: true };
    }
  }

  /** New chat with an empty input, signed in as an account (not a guest). */
  private async openFreshChat(page: Page): Promise<void> {
    await this.goHome(page);
    await page.waitForSelector(INPUT_SELECTOR, { timeout: NAV_TIMEOUT_MS });

    const token = await page
      .evaluate(() => localStorage.getItem("token"))
      .catch(() => null);
    const session = token ? await sessionKind(page, token) : "guest";
    if (session === "guest") {
      blog.warn("browser session is not signed in (guest or expired)");
      throw new AuthExpiredError(PROVIDER_ID);
    }
    if (session === "unknown") {
      throw new ProviderError(
        PROVIDER_ID,
        "Z.ai: could not check the session (network?) — try again",
      );
    }
  }

  /**
   * Puts the prompt into the chat box. A click is not usable: signed-in
   * accounts get "what's new" overlays on top of the input that swallow it.
   * Focus goes to the element directly, and Escape closes whatever is open.
   */
  private async typePrompt(page: Page, prompt: string): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.focus(INPUT_SELECTOR);
    await page.keyboard.insertText(prompt);

    // The box is a <textarea> or a rich-text editor depending on the account
    // settings; either way an empty box means the text went somewhere else.
    const typed = await page.$eval(INPUT_SELECTOR, (el) =>
      el instanceof HTMLTextAreaElement
        ? el.value.length
        : (el.textContent ?? "").length,
    );
    if (typed === 0) {
      throw new ProviderError(
        PROVIDER_ID,
        "Z.ai: could not type into the chat box (the web app changed?)",
      );
    }
  }

  /** Each request is a throwaway chat; keep the user's history clean. */
  private async deleteChat(chatId: string | null): Promise<void> {
    const page = this.page;
    if (!page || page.isClosed() || !chatId || chatId === "local") return;
    try {
      const status = await withTimeout(
        page.evaluate(async (id: string) => {
          const res = await fetch(`/api/v1/chats/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${localStorage.getItem("token") ?? ""}`,
            },
          });
          return res.status;
        }, chatId),
        DELETE_CHAT_TIMEOUT_MS,
        "delete chat",
      );
      blog.debug(`chat ${chatId} deleted (HTTP ${status})`);
    } catch (err) {
      blog.debug(`chat ${chatId} not deleted: ${errToString(err)}`);
    }
  }

  /**
   * The SPA may still be routing from the previous chat (`/c/…`) and abort our
   * navigation; that is a race, not a failure, so it gets one more try.
   */
  private async goHome(page: Page): Promise<void> {
    const go = () =>
      page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    try {
      await go();
    } catch (err) {
      if (!/ERR_ABORTED|interrupted by another navigation/i.test(errToString(err))) {
        throw err;
      }
      blog.debug("navigation home aborted by the page — retrying");
      await go();
    }
  }

  /**
   * Leaving the page aborts the in-flight fetch, so generation stops. It goes
   * back to the app rather than about:blank: the chat is deleted from this
   * page afterwards, which needs the app's origin and token.
   */
  private async stopPage(page: Page): Promise<void> {
    await this.goHome(page).catch(() => undefined);
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const previous = this.mutexChain;
    this.mutexChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  /**
   * Single-flight: parallel requests must share one launch, or the second
   * one hits the profile lock the first holds.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.launching ??= this.launchContext().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launchContext(): Promise<BrowserContext> {
    const headless = this.mode === "headless";
    blog.info(`launching browser bridge (mode=${this.mode})`);
    const context = await withTimeout(
      launchPersistentProfile(browserDataDir(), {
        headless,
        viewport: { width: 1280, height: 800 },
        args: headless ? LAUNCH_ARGS : [...LAUNCH_ARGS, ...OFFSCREEN_ARGS],
      }),
      LAUNCH_TIMEOUT_MS,
      "launch",
    );

    // Stealth: hide automation markers before any page script (WAF/anti-bot).
    await context.addInitScript(STEALTH_INIT).catch((err) => {
      blog.warn(`addInitScript failed: ${errToString(err)}`);
    });
    if (headless) await maskHeadless(context);
    await context.exposeBinding(SINK_BINDING, (_source, ev: SinkEvent) => {
      this.activeSink?.(ev);
    });
    await context.addInitScript(INTERCEPT_INIT, {
      sinkName: SINK_BINDING,
      overrideKey: OVERRIDE_KEY,
    });
    context.on("close", () => {
      this.context = undefined;
      this.page = undefined;
      // A request waiting on this browser would otherwise sit out its full
      // timeout on a dead page (e.g. when Sign In closes the bridge).
      this.activeSink?.({ t: "error", message: "the browser window was closed" });
    });

    blog.info("browser bridge launched");
    this.context = context;
    return context;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const context = await this.ensureContext();
    const page = context.pages()[0] ?? (await context.newPage());
    page.on("pageerror", (err) =>
      blog.debug(`[page error] ${errToString(err)}`),
    );
    this.page = page;
    // macOS clamps the off-screen position, so the window is also minimized.
    if (this.mode === "headed") await this.minimize(page);
    return page;
  }

  private async reveal(page: Page): Promise<void> {
    await this.setWindowBounds(page, { windowState: "normal" });
    await this.setWindowBounds(page, {
      left: 80,
      top: 80,
      width: 1100,
      height: 820,
    });
    await page.bringToFront().catch(() => undefined);
  }

  private async minimize(page: Page): Promise<void> {
    await this.setWindowBounds(page, { windowState: "minimized" });
  }

  private async setWindowBounds(
    page: Page,
    bounds: Record<string, unknown>,
  ): Promise<void> {
    if (!this.context) return;
    try {
      const cdp = await this.context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", { windowId, bounds });
      await cdp.detach().catch(() => undefined);
    } catch (err) {
      blog.debug(`setWindowBounds failed: ${errToString(err)}`);
    }
  }
}

/** Sink events in arrival order, awaited one at a time. */
class EventQueue {
  private readonly items: SinkEvent[] = [];
  private wake: (() => void) | undefined;

  push(ev: SinkEvent): void {
    this.items.push(ev);
    this.wake?.();
  }

  /** Next event, or undefined on timeout / abort. */
  async next(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SinkEvent | undefined> {
    if (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        signal?.addEventListener("abort", done, { once: true });
        this.wake = done;
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        }
      });
      this.wake = undefined;
    }
    if (signal?.aborted) return undefined;
    return this.items.shift();
  }

  /** Skips ahead to the first event of type `t`; errors end the wait. */
  async nextOf<T extends SinkEvent["t"]>(
    t: T,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Extract<SinkEvent, { t: T }> | undefined> {
    const deadline = Date.now() + timeoutMs;
    // Other events met on the way are kept for the reader, in order.
    const skipped: SinkEvent[] = [];
    try {
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) return undefined;
        const ev = await this.next(left, signal);
        if (!ev) return undefined;
        if (ev.t === "error") {
          throw new ProviderError(PROVIDER_ID, `Z.ai: ${ev.message}`);
        }
        if (ev.t === t) return ev as Extract<SinkEvent, { t: T }>;
        skipped.push(ev);
      }
    } finally {
      this.items.unshift(...skipped);
    }
  }
}

/**
 * Alibaba Cloud WAF's block page (chat.z.ai sits behind it): an HTML 405 in
 * Chinese with an `data-spm` tag. It answers the completion endpoint only,
 * after a burst of requests from one browser, and lifts by itself later —
 * the page and the rest of the API keep working, and there is no captcha to
 * solve.
 */
export const WAF_BLOCKED_MESSAGE =
  "Z.ai's anti-bot (Alibaba Cloud WAF) is blocking chat requests from this browser for now. This follows a burst of requests and lifts by itself — wait a few minutes or switch to another provider.";

function isWafBlockPage(status: number, body: string): boolean {
  return (
    (status === 405 || status === 403) &&
    /<html/i.test(body) &&
    /data-spm|aliyun|alibaba|lang="zh-cn"/i.test(body)
  );
}

/**
 * 401 is a lost session and 429 a rate limit; everything else is reported as
 * is. 403 deliberately stays a plain error: Z.ai uses it for "model not
 * available at your level", which must not sign the user out.
 */
export function httpError(status: number, body: string): Error {
  if (status === 401) return new AuthExpiredError(PROVIDER_ID, 401);
  if (status === 429) return new RateLimitError(PROVIDER_ID);
  if (isWafBlockPage(status, body)) {
    return new ProviderError(PROVIDER_ID, WAF_BLOCKED_MESSAGE, status);
  }
  const text = body.trim().replace(/\s+/g, " ").slice(0, 200);
  return new ProviderError(
    PROVIDER_ID,
    `Z.ai HTTP ${status}${text ? `: ${text}` : ""}`,
    status,
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProviderError(PROVIDER_ID, `browser bridge timeout: ${label}`),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs in every document before the page's own scripts. Wraps `fetch` so the
 * one completion request we triggered carries our model and thinking mode, and
 * tees its body to the binding. The override is one-shot: anything else the
 * page fetches passes through untouched.
 */
const INTERCEPT_INIT = (args: { sinkName: string; overrideKey: string }) => {
  const w = window as unknown as Record<string, unknown>;
  const original = window.fetch;

  window.fetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const override = w[args.overrideKey] as
      | { model: string; thinking: boolean }
      | undefined;

    if (
      !override ||
      !/\/chat\/completions(\?|$)/.test(url) ||
      typeof init?.body !== "string"
    ) {
      return original.call(window, input, init);
    }

    w[args.overrideKey] = undefined;
    const sink = w[args.sinkName] as (ev: unknown) => Promise<void>;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return original.call(window, input, init);
    }

    body.model = override.model;
    body.features = {
      ...(body.features as Record<string, unknown> | undefined),
      enable_thinking: override.thinking,
      web_search: false,
      auto_web_search: false,
      image_generation: false,
      // The web app now runs every chat as its "general agent": the model
      // works in Z.ai's own server sandbox with its own tools and never
      // reaches the caller's tools. A plain chat keeps it on our protocol.
      flags: [],
      preview_mode: false,
    };
    // Title/tag generation would be a second model call for a chat we delete.
    delete body.background_tasks;
    delete body.mcp_servers;

    void sink({
      t: "request",
      chatId: typeof body.chat_id === "string" ? body.chat_id : null,
    });

    let res: Response;
    try {
      res = await original.call(window, input, {
        ...init,
        body: JSON.stringify(body),
      });
    } catch (e) {
      void sink({ t: "error", message: String((e as Error)?.message ?? e) });
      throw e;
    }

    void sink({
      t: "head",
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
    });

    if (!res.body) {
      const text = await res
        .clone()
        .text()
        .catch(() => "");
      if (text) void sink({ t: "chunk", data: text });
      void sink({ t: "end" });
      return res;
    }

    const [ours, theirs] = res.body.tee();
    void (async () => {
      const reader = ours.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const data = decoder.decode(value, { stream: true });
          if (data) await sink({ t: "chunk", data });
        }
        const tail = decoder.decode();
        if (tail) await sink({ t: "chunk", data: tail });
        await sink({ t: "end" });
      } catch (e) {
        await sink({ t: "error", message: String((e as Error)?.message ?? e) });
      }
    })();

    return new Response(theirs, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
};
