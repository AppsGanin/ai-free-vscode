import * as path from "path";
import type { BrowserContext, LaunchOptions, Page } from "playwright";
import { chromium } from "playwright";
import { createLogger, errToString } from "../../logger";
import { hostSettings } from "./hostSettings";

const log = createLogger("browser");

/** Every provider keeps its own browser profile under one root. */
export function profileDir(name: string): string {
  return path.join(hostSettings().profileRoot(), name);
}

export function loginTimeoutMs(): number {
  return hostSettings().loginTimeoutMs();
}

export interface LaunchProfileOptions extends LaunchOptions {
  viewport?: { width: number; height: number };
  serviceWorkers?: "allow" | "block";
}

/**
 * Persistent context on `dataDir`. The system Chrome binary is tried first: it
 * is not flagged as automated, so Google OAuth and the anti-bots let it
 * through. Falls back to the bundled Chromium.
 */
export async function launchPersistentProfile(
  dataDir: string,
  launchOptions: LaunchProfileOptions,
): Promise<BrowserContext> {
  const proxy = browserProxy();
  const options = proxy ? { ...launchOptions, proxy } : launchOptions;
  const what = `${path.basename(dataDir)} profile (${launchOptions.headless === false ? "headed" : "headless"}${
    proxy ? `, proxy ${proxy.server}${proxy.bypass ? ` bypass ${proxy.bypass}` : ""}` : ""
  })`;
  try {
    const context = await chromium.launchPersistentContext(dataDir, {
      ...options,
      channel: "chrome",
    });
    log.debug(`system Chrome ${context.browser()?.version() ?? ""} for the ${what}`);
    return trackProxy(context, proxy);
  } catch (err) {
    // A missing Chrome is fine; a profile locked by another window is not,
    // and both end up here — the reason tells them apart.
    log.warn(
      `system Chrome failed for the ${what}, using bundled Chromium: ${errToString(err).split("\n")[0]}`,
    );
    const context = await chromium.launchPersistentContext(dataDir, options);
    log.debug(`bundled Chromium ${context.browser()?.version() ?? ""} for the ${what}`);
    return trackProxy(context, proxy);
  }
}

/**
 * A running browser keeps the proxy it was launched with, so changing or
 * removing the setting would leave it on the old (maybe dead) proxy —
 * ERR_EMPTY_RESPONSE and the like. Such a context is closed on the change; the
 * bridges treat a closed context as "not launched" and start a fresh one on
 * the next request.
 */
const running = new Map<BrowserContext, string>();
let watchingProxy = false;

function proxyKey(proxy: LaunchOptions["proxy"] | undefined): string {
  return JSON.stringify(proxy ?? null);
}

function trackProxy(
  context: BrowserContext,
  proxy: LaunchOptions["proxy"] | undefined,
): BrowserContext {
  running.set(context, proxyKey(proxy));
  context.on("close", () => running.delete(context));
  if (!watchingProxy) {
    watchingProxy = true;
    hostSettings().onProxyChange(() => {
      const now = proxyKey(browserProxy());
      for (const [ctx, key] of running) {
        if (key === now) continue;
        log.info("proxy setting changed — closing the browser that used the old one");
        void ctx.close().catch(() => undefined);
      }
    });
  }
  return context;
}

/**
 * Proxy for the browser windows, from the host's settings.
 *
 * Requests made from Node (DeepSeek, Kimi, Qwen's direct path) already go
 * through the host's proxy support for `fetch`; the browsers are a separate
 * process and need it handed over explicitly.
 */
export function browserProxy(): LaunchOptions["proxy"] | undefined {
  const raw = hostSettings().proxy().trim();
  // A typo must not take every provider down; the browsers go direct.
  const proxy = raw ? parseProxy(raw) : undefined;
  if (!proxy) return undefined;

  const bypass = hostSettings()
    .noProxy()
    .map((host) => host.trim())
    .filter(Boolean)
    .join(",");
  return bypass ? { ...proxy, bypass } : proxy;
}

/** `http://user:pass@host:port`, `socks5://host:port` or bare `host:port`. */
export function parseProxy(raw: string): LaunchOptions["proxy"] | undefined {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    return undefined;
  }
  if (!url.hostname) return undefined;
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

/** Where a proxy check reads the external address from. */
const IP_ECHO_URL = "https://api.ipify.org/?format=json";
const PROXY_CHECK_TIMEOUT_MS = 20_000;

export interface ProxyCheck {
  /** External address the sites see through the proxy. */
  ip: string;
  ms: number;
}

/**
 * Opens the IP echo through `raw` in a throwaway headless Chrome — no profile,
 * no cookies, so nothing of the user's sessions passes an untested proxy —
 * and returns the address the sites see. Throws a readable reason otherwise.
 */
export async function checkProxy(raw: string): Promise<ProxyCheck> {
  const proxy = parseProxy(raw);
  if (!proxy) {
    throw new Error(
      "Not a proxy address — expected http://host:port, http://user:pass@host:port or socks5://host:port.",
    );
  }

  const options: LaunchOptions = { headless: true, proxy };
  const browser = await chromium
    .launch({ ...options, channel: "chrome" })
    .catch(() => chromium.launch(options));
  const startedAt = Date.now();
  try {
    const page = await browser.newPage();
    await page.goto(IP_ECHO_URL, {
      waitUntil: "domcontentloaded",
      timeout: PROXY_CHECK_TIMEOUT_MS,
    });
    const body = (await page.textContent("body")) ?? "";
    const ip = (JSON.parse(body) as { ip?: unknown }).ip;
    if (typeof ip !== "string" || !ip) {
      throw new Error(`Unexpected answer through the proxy: ${body.slice(0, 80)}`);
    }
    return { ip, ms: Date.now() - startedAt };
  } catch (err) {
    throw new Error(describeProxyFailure(err instanceof Error ? err.message : String(err)));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** Chrome's network error for a failed proxy, as something to act on. */
export function describeProxyFailure(message: string): string {
  const reasons: Array<[RegExp, string]> = [
    [/ERR_TUNNEL_CONNECTION_FAILED/, "The proxy refused to connect to the site — it is dead, blocks HTTPS, or needs a login (http://user:pass@host:port)."],
    [/ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/, "Cannot reach the proxy — wrong host or port, or it is offline."],
    [/ERR_SOCKS_CONNECTION_FAILED|ERR_SOCKS/, "The SOCKS handshake failed — the proxy is dead, needs a login, or is not SOCKS5."],
    [/ERR_PROXY_AUTH|407/, "The proxy rejected the login."],
    [/ERR_NAME_NOT_RESOLVED/, "The proxy host name does not resolve."],
    [/Timeout|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i, `No answer within ${PROXY_CHECK_TIMEOUT_MS / 1000} s — the proxy is too slow or dead.`],
  ];
  for (const [pattern, reason] of reasons) {
    if (pattern.test(message)) return reason;
  }
  return message.split("\n")[0].slice(0, 200);
}

/** Persistent context for an interactive sign-in. */
export function launchLoginContext(dataDir: string): Promise<BrowserContext> {
  return launchPersistentProfile(dataDir, {
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
  });
}

/** Polls `read` until it returns a token or the timeout expires. */
export async function pollForToken(
  page: Page,
  timeoutMs: number,
  intervalMs: number,
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const token = await read();
    if (token) return token;
    await page.waitForTimeout(intervalMs);
  }
  return undefined;
}

/** Reads the first non-empty value among the given localStorage keys. */
export function readLocalStorage(
  page: Page,
  keys: string[],
): Promise<string | null> {
  return page
    .evaluate((names: string[]) => {
      try {
        for (const name of names) {
          const value = localStorage.getItem(name);
          if (value) return value;
        }
      } catch {
        // storage blocked on this origin
      }
      return null;
    }, keys)
    .catch(() => null);
}

/** Strips `Bearer`, quotes and JSON wrappers off a stored token. */
export function normalizeToken(raw?: string | null): string | undefined {
  if (!raw) return undefined;

  let token = String(raw)
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  if (token.startsWith("{") || token.startsWith("[")) {
    try {
      const parsed = JSON.parse(token) as
        | string
        | Record<"token" | "accessToken" | "access_token" | "value", string>;
      token =
        typeof parsed === "string"
          ? parsed
          : (parsed.access_token ??
            parsed.accessToken ??
            parsed.token ??
            parsed.value ??
            token);
    } catch {
      // not JSON — keep as is
    }
  }

  return token || undefined;
}
