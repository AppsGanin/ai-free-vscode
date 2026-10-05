import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, type Page, chromium } from "playwright";
import { normalizeToken } from "../../src/providers/common/browserAuth";

/**
 * Reads a signed-in session out of a provider's browser profile — the same
 * place Sign In leaves it — and returns it in the shape the provider keeps in
 * SecretStorage. When the profile is signed out, a visible window opens on
 * the sign-in page and the run waits for the user (not on CI).
 */

export const PROFILE_DIRS = {
  qwen: "browser-profile",
  deepseek: "deepseek-browser-profile",
  kimi: "kimi-browser-profile",
  zai: "zai-browser-profile",
} as const;

export type LiveProvider = keyof typeof PROFILE_DIRS;

export function profilePath(provider: LiveProvider): string {
  return join(homedir(), ".ai-free-vscode", PROFILE_DIRS[provider]);
}

/** Why a live test cannot run, or undefined when it can. */
export function unavailable(provider: LiveProvider): string | undefined {
  // Chrome holds one profile per process: the running extension wins.
  if (lockHolderAlive(join(profilePath(provider), "SingletonLock"))) {
    return `profile in use (VS Code dev host running?) — ${profilePath(provider)}`;
  }
  return undefined;
}

/**
 * Chrome's lock is a symlink to `<host>-<pid>`. A crashed or killed browser
 * leaves it behind; Chrome takes such a lock over, so only a live owner counts.
 */
function lockHolderAlive(lock: string): boolean {
  let target: string;
  try {
    target = readlinkSync(lock);
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!Number.isInteger(pid)) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HOME: Record<LiveProvider, string> = {
  qwen: "https://chat.qwen.ai",
  deepseek: "https://chat.deepseek.com",
  kimi: "https://www.kimi.ai",
  zai: "https://chat.z.ai",
};

const SIGN_IN: Record<LiveProvider, string> = {
  qwen: "https://chat.qwen.ai/auth?action=signin",
  deepseek: "https://chat.deepseek.com/sign_in",
  kimi: "https://www.kimi.ai",
  zai: "https://chat.z.ai/auth",
};

/** How long a run waits for the user to sign in. `LIVE_LOGIN_TIMEOUT` in seconds. */
export const SIGN_IN_TIMEOUT_MS =
  Number(process.env.LIVE_LOGIN_TIMEOUT ?? 300) * 1000;

/** Waiting for a human makes no sense on CI; there the test just fails. */
const CAN_WAIT = !process.env.CI;

const OFFSCREEN = ["--window-position=-32000,-32000"];

function launch(provider: LiveProvider, visible: boolean): Promise<BrowserContext> {
  const options = {
    headless: false,
    viewport: visible ? { width: 1200, height: 820 } : undefined,
    args: visible ? ["--disable-blink-features=AutomationControlled"] : OFFSCREEN,
  };
  return chromium
    .launchPersistentContext(profilePath(provider), { ...options, channel: "chrome" })
    .catch(() => chromium.launchPersistentContext(profilePath(provider), options));
}

/**
 * Kimi keeps its access token under a random localStorage key next to the
 * refresh token; the reliable copy is the Bearer the page itself sends — the
 * same one KimiAuthManager captures at sign-in. The last one wins: a guest
 * token comes first and is replaced once the account loads.
 */
function watchBearer(
  page: Page,
  provider: LiveProvider,
  host = new URL(HOME[provider]).host,
): () => string | undefined {
  let bearer: string | undefined;
  page.on("request", (request) => {
    const auth = request.headers()["authorization"];
    if (auth?.startsWith("Bearer eyJ") && request.url().includes(host)) {
      bearer = auth.slice("Bearer ".length).trim();
    }
  });
  return () => bearer;
}

async function storage(page: Page, keys: string[]): Promise<string | null> {
  return page
    .evaluate((names: string[]) => {
      for (const name of names) {
        const value = localStorage.getItem(name);
        if (value) return value;
      }
      for (let i = 0; i < localStorage.length; i++) {
        const value = localStorage.getItem(localStorage.key(i) ?? "");
        if (value?.startsWith("eyJ")) return value;
      }
      return null;
    }, keys)
    .catch(() => null);
}

/** Asks an account-only endpoint from inside the page; guests are refused. */
async function signedIn(page: Page, url: string, init: RequestInit): Promise<unknown> {
  return page
    .evaluate(
      async ({ url, init }) => {
        try {
          const res = await fetch(url, init);
          return res.ok ? await res.json() : undefined;
        } catch {
          return undefined;
        }
      },
      { url, init: init as Record<string, unknown> },
    )
    .catch(() => undefined);
}

/** The session as SecretStorage contents, or undefined while signed out. */
async function extract(
  provider: LiveProvider,
  context: BrowserContext,
  page: Page,
  bearer: () => string | undefined,
): Promise<Record<string, string> | undefined> {
  switch (provider) {
    case "qwen": {
      const token = normalizeToken(
        await storage(page, ["token", "__token", "accessToken", "access_token", "userToken"]),
      );
      return token ? { "ai-free-vscode.qwen.token": token } : undefined;
    }
    case "kimi": {
      const token = bearer() ?? normalizeToken(await storage(page, ["access_token", "token"]));
      if (!token?.startsWith("eyJ")) return undefined;
      // kimi.com hands every visitor a guest token; only an account has a
      // subscription record.
      const subscription = (await signedIn(
        page,
        "/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
          },
          body: "{}",
        },
      )) as { subscription?: unknown } | undefined;
      // The region is the page's: kimi.ai (global) or kimi.com (China).
      const origin = new URL(page.url()).origin;
      return subscription?.subscription
        ? { "ai-free-vscode.kimi.auth": JSON.stringify({ token, origin }) }
        : undefined;
    }
    case "deepseek": {
      const token = normalizeToken(await storage(page, ["userToken", "token", "access_token"]));
      const cookieHeader = (await context.cookies(HOME.deepseek))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return token && cookieHeader.includes("ds_session_id=")
        ? {
            "ai-free-vscode.deepseek.auth": JSON.stringify({ token, cookieHeader }),
          }
        : undefined;
    }
    case "zai": {
      // The bridge sends through this very profile; the secret only marks the
      // provider as signed in. Guests get a token too — the role tells them apart.
      const token = normalizeToken(await storage(page, ["token"]));
      if (!token) return undefined;
      const me = (await signedIn(page, "/api/v1/auths/", {
        headers: { Authorization: `Bearer ${token}` },
      })) as { role?: string } | undefined;
      return me?.role && me.role !== "guest"
        ? { "ai-free-vscode.zai.auth": JSON.stringify({ token }) }
        : undefined;
    }
  }
}

/**
 * SecretStorage contents for the provider. Signed out: opens a visible window
 * on the sign-in page and waits for the user, up to SIGN_IN_TIMEOUT_MS.
 */
export async function readSession(
  provider: LiveProvider,
): Promise<Record<string, string> | undefined> {
  // First a quiet look, off-screen: most runs find a session right away.
  // Kimi has two regions with separate accounts; either one will do.
  const homes = provider === "kimi" ? [HOME.kimi, "https://www.kimi.com"] : [HOME[provider]];
  let context = await launch(provider, false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    for (const home of homes) {
      const bearer = watchBearer(page, provider, new URL(home).host);
      await page.goto(home, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(provider === "kimi" ? 8000 : 2500);
      const session = await extract(provider, context, page, bearer);
      if (session) return session;
    }
    if (!CAN_WAIT) return undefined;
  } finally {
    await context.close();
  }

  // Signed out: hand the window to the user.
  context = await launch(provider, true);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const bearer = watchBearer(page, provider);
    await page.goto(SIGN_IN[provider], { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.bringToFront();
    const seconds = Math.round(SIGN_IN_TIMEOUT_MS / 1000);
    const wait = seconds >= 120 ? `${Math.round(seconds / 60)} min` : `${seconds} s`;
    console.log(
      `\n>>> ${provider}: not signed in. Sign in in the opened browser window — waiting up to ${wait}.\n`,
    );

    const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000).catch(() => undefined);
      if (page.isClosed()) break;
      const session = await extract(provider, context, page, bearer);
      if (session) {
        console.log(`>>> ${provider}: signed in, continuing.`);
        // Let the site finish writing its session before the profile closes.
        await page.waitForTimeout(2000).catch(() => undefined);
        return session;
      }
    }
    return undefined;
  } finally {
    await context.close();
  }
}

/** A SecretStorage over a fixed map. Writes are kept in memory only. */
export function memorySecrets(values: Record<string, string>) {
  const store = new Map(Object.entries(values));
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    keys: async () => [...store.keys()],
    onDidChange: () => ({ dispose() {} }),
  };
}
