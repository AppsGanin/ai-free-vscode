import { rm } from "fs/promises";
import type { Page } from "playwright";
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
import type { SecretStore } from "../types";

const AUTH_SECRET_KEY = "ai-free-vscode.kimi.auth";
// Kimi runs two regions with separate accounts: kimi.ai (global) and kimi.com
// (China). Sign-in opens the global one; a China account signs in after
// switching to kimi.com in the same window, and the host it used is stored.
const HOME_URL = "https://www.kimi.ai";
/** An origin Kimi serves its app and API from. */
const KIMI_ORIGIN = /^https:\/\/www\.kimi\.(ai|com)$/;
/** Sessions stored before the host was recorded all came from kimi.com. */
export const LEGACY_KIMI_ORIGIN = "https://www.kimi.com";
const browserDataDir = (): string => profileDir("kimi-browser-profile");

const klog = createLogger("kimi-auth");

export interface KimiAuthPayload {
  /** JWT access token (Bearer). Lives about 15 minutes. */
  token: string;
  /** Region the account lives in: `https://www.kimi.ai` or `https://www.kimi.com`. */
  origin: string;
  /**
   * Long-lived token the web app trades for a new access token; absent in
   * sign-ins stored before refreshing existed.
   */
  refreshToken?: string;
}

const REFRESH_PATH = "/api/account.gateway.v1.AuthService/RefreshToken";
/** Refreshed ahead of a request when the access token is this close to expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/** Kimi's auth service lives on its own host: auth.kimi.ai / auth.kimi.com. */
function authHost(origin: string): string {
  return origin.replace("://www.", "://auth.");
}

/** Whether the JWT expires within the margin (or carries no expiry we can read). */
export function expiresSoon(token: string, now = Date.now()): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof payload.exp === "number" && payload.exp * 1000 - now < EXPIRY_MARGIN_MS;
  } catch {
    return false;
  }
}

export class KimiAuthManager {
  async login(secrets: SecretStore): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    klog.info("login: opening browser");
    const context = await launchLoginContext(browserDataDir());
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
      // The access token lives minutes; without this the session would end
      // with it.
      const refreshToken = jwt(await readLocalStorage(page, ["refresh_token"]));
      await secrets.store(AUTH_SECRET_KEY, JSON.stringify({ token, origin, refreshToken }));
      klog.info(`login: success, token stored (${origin}${refreshToken ? ", refreshable" : ""})`);
    } catch (err) {
      klog.error(`login: failed — ${errToString(err)}`);
      throw err;
    } finally {
      await context.close();
    }
  }

  async logout(secrets: SecretStore): Promise<void> {
    await secrets.delete(AUTH_SECRET_KEY);
    await rm(browserDataDir(), { recursive: true, force: true }).catch(
      () => {},
    );
    klog.info("logout: token and browser profile cleared");
  }

  /** Drops the sign-in holding `rejected` after the server refused it. */
  async forget(secrets: SecretStore, rejected: string): Promise<void> {
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

  /**
   * Trades the refresh token for a new pair, as the web app does when its
   * access token runs out. Single-flight: parallel requests share one trade.
   *
   * @returns the stored sign-in after the refresh, or undefined when there is
   * nothing to refresh with or Kimi refused it.
   */
  refresh(secrets: SecretStore, current: KimiAuthPayload): Promise<KimiAuthPayload | undefined> {
    this.refreshing ??= this.tradeRefreshToken(secrets, current).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private refreshing: Promise<KimiAuthPayload | undefined> | undefined;

  private async tradeRefreshToken(
    secrets: SecretStore,
    current: KimiAuthPayload,
  ): Promise<KimiAuthPayload | undefined> {
    // Someone else refreshed (or signed in) meanwhile: use theirs.
    const stored = await this.getAuth(secrets);
    if (stored && stored.token !== current.token) return stored;
    if (!current.refreshToken) {
      klog.info("refresh: no refresh token stored (signed in before refreshing existed)");
      return undefined;
    }
    try {
      const response = await fetch(`${authHost(current.origin)}${REFRESH_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          Origin: current.origin,
          Referer: `${current.origin}/`,
          "X-Msh-Platform": "web",
        },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
        signal: AbortSignal.timeout(15000),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const token = jwt(String(body.accessToken ?? body.access_token ?? ""));
      const refreshToken = jwt(String(body.refreshToken ?? body.refresh_token ?? ""));
      if (!response.ok || !token) {
        klog.warn(`refresh: refused (HTTP ${response.status})`);
        return undefined;
      }
      const next = { token, origin: current.origin, refreshToken: refreshToken ?? current.refreshToken };
      await secrets.store(AUTH_SECRET_KEY, JSON.stringify(next));
      klog.info("refresh: new access token stored");
      return next;
    } catch (err) {
      klog.warn(`refresh: failed — ${errToString(err)}`);
      return undefined;
    }
  }

  async isAuthenticated(secrets: SecretStore): Promise<boolean> {
    return !!(await this.getAuth(secrets));
  }

  async getAuth(
    secrets: SecretStore,
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
      const refreshToken = jwt(parsed.refreshToken);
      return token ? { token, origin, ...(refreshToken ? { refreshToken } : {}) } : undefined;
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
