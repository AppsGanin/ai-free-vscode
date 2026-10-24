import { rm } from "fs/promises";
import type { Page } from "playwright";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";
import {
  launchLoginContext,
  loginTimeoutMs,
  normalizeToken,
  pollForToken,
  profileDir,
  readLocalStorage,
} from "../common/browserAuth";
import { forgetRejected, storedToken } from "../common/rejectedAuth";

const AUTH_SECRET_KEY = "ai-free-vscode.kimi.auth";
// Kimi runs two regions with separate accounts: kimi.ai (global) and kimi.com
// (China). Sign-in opens the global one; a China account signs in after
// switching to kimi.com in the same window, and the host it used is stored.
const HOME_URL = "https://www.kimi.ai";
/** An origin Kimi serves its app and API from. */
const KIMI_ORIGIN = /^https:\/\/www\.kimi\.(ai|com)$/;
/** Sessions stored before the host was recorded all came from kimi.com. */
export const LEGACY_KIMI_ORIGIN = "https://www.kimi.com";
const BROWSER_DATA_DIR = profileDir("kimi-browser-profile");

const klog = createLogger("kimi-auth");

export interface KimiAuthPayload {
  /** JWT access token (Bearer). */
  token: string;
  /** Region the account lives in: `https://www.kimi.ai` or `https://www.kimi.com`. */
  origin: string;
}

export class KimiAuthManager {
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    klog.info("login: opening browser");
    const context = await launchLoginContext(BROWSER_DATA_DIR);
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await context.clearCookies().catch(() => undefined);

      // kimi.com hands out a guest token on load, so keep the LAST one seen:
      // after sign-in it is replaced by the real account token.
      let capturedToken: string | undefined;
      let capturedOrigin: string | undefined;
      page.on("request", (request) => {
        // Either region; the token belongs to the host it was sent to.
        const origin = new URL(request.url()).origin;
        if (!KIMI_ORIGIN.test(origin)) return;
        const auth = request.headers()["authorization"];
        if (auth?.startsWith("Bearer eyJ")) {
          capturedToken = auth.slice("Bearer ".length).trim();
          capturedOrigin = origin;
        }
      });

      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      klog.info(
        `login: waiting for non-guest sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );

      // Only re-check a token that actually changed, to avoid spamming the API.
      let lastChecked: string | undefined;
      const token = await pollForToken(page, timeoutMs, 900, async () => {
        const candidate =
          jwt(capturedToken) ??
          jwt(await readLocalStorage(page, ["access_token", "token"]));
        if (!candidate || candidate === lastChecked) return undefined;

        lastChecked = candidate;
        if (await this.isLoggedInToken(page, candidate)) {
          klog.info("login: token validated (logged-in account)");
          return candidate;
        }
        klog.debug("login: candidate rejected (guest/invalid token)");
        return undefined;
      });

      if (!token) {
        klog.warn("login: sign-in not detected within timeout (still guest)");
        throw new Error(
          "Kimi: sign-in not detected. Log in to your account in the opened window (a guest session is not enough) and try again.",
        );
      }

      const pageOrigin = new URL(page.url()).origin;
      const origin =
        capturedOrigin ?? (KIMI_ORIGIN.test(pageOrigin) ? pageOrigin : HOME_URL);
      await secrets.store(AUTH_SECRET_KEY, JSON.stringify({ token, origin }));
      klog.info(`login: success, token stored (${origin})`);
    } catch (err) {
      klog.error(`login: failed — ${errToString(err)}`);
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
    klog.info("logout: token and browser profile cleared");
  }

  /** Drops the sign-in holding `rejected` after the server refused it. */
  async forget(secrets: vscode.SecretStorage, rejected: string): Promise<void> {
    if (
      await forgetRejected(
        secrets,
        AUTH_SECRET_KEY,
        (stored) => jwt(storedToken(stored)) === rejected,
      )
    ) {
      klog.info("forget: rejected token removed");
    }
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return !!(await this.getAuth(secrets));
  }

  async getAuth(
    secrets: vscode.SecretStorage,
  ): Promise<KimiAuthPayload | undefined> {
    const raw = await secrets.get(AUTH_SECRET_KEY);
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as Partial<KimiAuthPayload>;
      const token = jwt(parsed.token);
      const origin =
        typeof parsed.origin === "string" && KIMI_ORIGIN.test(parsed.origin)
          ? parsed.origin
          : LEGACY_KIMI_ORIGIN;
      return token ? { token, origin } : undefined;
    } catch (err) {
      klog.warn(`getAuth: parse failed — ${errToString(err)}`);
      return undefined;
    }
  }

  /**
   * Checks the token from inside the page (its origin and cookies).
   * GetSubscription answers only for a signed-in user; guests get 401.
   */
  private async isLoggedInToken(page: Page, token: string): Promise<boolean> {
    try {
      return await page.evaluate(async (bearer: string) => {
        try {
          const res = await fetch(
            "/apiv2/kimi.gateway.order.v1.SubscriptionService/GetSubscription",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${bearer}`,
                "Content-Type": "application/json",
                "Connect-Protocol-Version": "1",
              },
              body: "{}",
            },
          );
          if (!res.ok) return false;
          const data = (await res.json()) as { subscription?: unknown };
          return !!data?.subscription;
        } catch {
          return false;
        }
      }, token);
    } catch {
      return false;
    }
  }
}

/** Kimi tokens are always JWTs; anything else is not usable. */
function jwt(raw?: string | null): string | undefined {
  const token = normalizeToken(raw);
  return token?.startsWith("eyJ") ? token : undefined;
}
