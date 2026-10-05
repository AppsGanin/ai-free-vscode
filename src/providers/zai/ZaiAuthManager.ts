import { rm } from "fs/promises";
import type { Page } from "playwright";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";
import {
  launchLoginContext,
  loginTimeoutMs,
  normalizeToken,
  pollForToken,
  readLocalStorage,
} from "../common/browserAuth";
import { BROWSER_DATA_DIR, HOME_URL } from "./ZaiBrowser";

const AUTH_SECRET_KEY = "ai-free-vscode.zai.auth";

const zlog = createLogger("zai-auth");

export interface ZaiAuthPayload {
  /** JWT of the signed-in account, as the web app keeps it in localStorage. */
  token: string;
}

/**
 * Sign-in for chat.z.ai.
 *
 * Requests themselves go through the browser bridge, which reads the session
 * from the same profile; the stored token marks the provider as signed in and
 * lets the bridge notice when the browser session no longer matches.
 */
export class ZaiAuthManager {
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    zlog.info("login: opening browser");
    const context = await launchLoginContext(BROWSER_DATA_DIR);
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await signOutOfProfile(page);

      zlog.info(
        `login: waiting for non-guest sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );

      // chat.z.ai hands every visitor a guest token, so only a token that
      // changed is worth checking against the account endpoint.
      let lastChecked: string | undefined;
      const token = await pollForToken(page, timeoutMs, 900, async () => {
        const candidate = jwt(await readLocalStorage(page, ["token"]));
        if (!candidate || candidate === lastChecked) return undefined;

        const session = await sessionKind(page, candidate);
        if (session === "account") {
          zlog.info("login: token validated (signed-in account)");
          return candidate;
        }
        // An unanswered check proves nothing: retry the same token next tick.
        if (session === "guest") lastChecked = candidate;
        zlog.debug(`login: candidate not accepted (${session})`);
        return undefined;
      });

      if (!token) {
        zlog.warn("login: sign-in not detected within timeout (still guest)");
        throw new Error(
          "Z.ai: sign-in not detected. Log in to your account in the opened window (a guest session is not enough) and try again.",
        );
      }

      await secrets.store(AUTH_SECRET_KEY, JSON.stringify({ token }));
      zlog.info("login: success, token stored");
    } catch (err) {
      zlog.error(`login: failed — ${errToString(err)}`);
      throw err;
    } finally {
      await context.close();
    }
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(AUTH_SECRET_KEY);
    await rm(BROWSER_DATA_DIR, { recursive: true, force: true }).catch(
      () => {},
    );
    zlog.info("logout: token and browser profile cleared");
  }

  /** Drops the stored sign-in but keeps the profile, so re-login is quick. */
  async forget(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(AUTH_SECRET_KEY);
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return !!(await this.getAuth(secrets));
  }

  async getAuth(
    secrets: vscode.SecretStorage,
  ): Promise<ZaiAuthPayload | undefined> {
    const raw = await secrets.get(AUTH_SECRET_KEY);
    if (!raw) return undefined;

    try {
      const token = jwt((JSON.parse(raw) as ZaiAuthPayload).token);
      return token ? { token } : undefined;
    } catch (err) {
      zlog.warn(`getAuth: parse failed — ${errToString(err)}`);
      return undefined;
    }
  }
}

/**
 * `account` / `guest` as the server says; `unknown` when it did not answer
 * (network, 5xx). The difference matters: only a real "not signed in" may sign
 * the user out — a hiccup must not.
 */
export type SessionKind = "account" | "guest" | "unknown";

/**
 * Asks the account endpoint from inside the page. A guest token answers too,
 * so the role is what tells a real account apart.
 */
export async function sessionKind(
  page: Page,
  token: string,
): Promise<SessionKind> {
  try {
    return await page.evaluate(async (bearer: string) => {
      try {
        const res = await fetch("/api/v1/auths/", {
          headers: { Authorization: `Bearer ${bearer}` },
        });
        if (res.status === 401 || res.status === 403) return "guest";
        if (!res.ok) return "unknown";
        const data = (await res.json()) as { role?: string };
        return data.role && data.role !== "guest" ? "account" : "guest";
      } catch {
        return "unknown";
      }
    }, token);
  } catch {
    return "unknown";
  }
}

/**
 * Leaves the page signed out, as a guest, so sign-in always waits for the user.
 * A session left in the profile would otherwise be accepted on the first poll:
 * the window closed before the user saw it, and another account could never be
 * picked.
 *
 * The order matters. The session lives in localStorage *and* in an httpOnly
 * `token` cookie, and the app re-creates each from the other: visiting the
 * page with the old localStorage sets the cookie, reloading with the cookie
 * restores the account. So: storage first, then leave the app so it cannot
 * write the token back, then the cookies, then a fresh visit.
 */
async function signOutOfProfile(page: Page): Promise<void> {
  const navigate = (url: string) =>
    page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  await navigate(HOME_URL);
  await page
    .evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    })
    .catch(() => undefined);
  await navigate("about:blank");
  await page
    .context()
    .clearCookies()
    .catch(() => undefined);
  // Straight to the sign-in options rather than the chat, where the user
  // would first have to find the login button.
  await navigate(`${HOME_URL}/auth`);
}

/** Z.ai tokens are always JWTs; anything else is not usable. */
function jwt(raw?: string | null): string | undefined {
  const token = normalizeToken(raw);
  return token?.startsWith("eyJ") ? token : undefined;
}
