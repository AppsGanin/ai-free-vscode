import { rm } from "fs/promises";
import type { BrowserContext, Response } from "playwright";
import { createLogger, errToString } from "../../logger";
import {
  launchLoginContext,
  launchPersistentProfile,
  loginTimeoutMs,
  normalizeToken,
  pollForToken,
  profileDir,
  readLocalStorage,
} from "../common/browserAuth";
import { forgetRejected } from "../common/rejectedAuth";
import type { SecretStore } from "../types";

const AUTH_SECRET_KEY = "ai-free-vscode.deepseek.auth";
const HOME_URL = "https://chat.deepseek.com";
/** How long a background read of the profile waits for the app's first API call. */
const REREAD_TIMEOUT_MS = 20000;
const browserDataDir = (): string => profileDir("deepseek-browser-profile");

const dlog = createLogger("deepseek-auth");

interface DeepSeekAuthPayload {
  token?: string;
  cookieHeader: string;
}

export class DeepSeekAuthManager {
  async login(secrets: SecretStore): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    dlog.info("login: opening browser");
    const context = await launchLoginContext(browserDataDir());
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      // Clear the old session first, otherwise a stale one reports success.
      await context.clearCookies().catch(() => undefined);
      await page.goto(HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page
        .evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            // storage blocked on this origin
          }
        })
        .catch(() => undefined);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });

      dlog.info(
        `login: waiting for sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );
      const captured = await this.waitForAuthApiCall(context, timeoutMs);
      const token =
        normalizeToken(captured) ??
        (await pollForToken(page, 4000, 700, async () =>
          normalizeToken(
            await readLocalStorage(page, [
              "userToken",
              "token",
              "access_token",
            ]),
          ),
        ));

      const cookieHeader = (await context.cookies(HOME_URL))
        .filter((c) => c?.name && typeof c.value === "string")
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      if (!cookieHeader.includes("ds_session_id=")) {
        dlog.warn("login: ds_session_id cookie missing (sign-in incomplete)");
        throw new Error(
          "Failed to get DeepSeek cookies (ds_session_id). Sign in and try again.",
        );
      }

      await secrets.store(
        AUTH_SECRET_KEY,
        JSON.stringify({ token: token || undefined, cookieHeader }),
      );
      dlog.info(`login: success, token=${token ? "yes" : "no"}, cookie stored`);
    } catch (err) {
      dlog.error(`login: failed — ${errToString(err)}`);
      throw err;
    } finally {
      await context.close();
    }
  }

  /**
   * The session the browser profile holds now, read in the background: the
   * profile often outlives a stored token the API has started refusing.
   * Single-flight: parallel requests share one read.
   *
   * @returns the stored sign-in when the profile had a different, signed-in
   * session, undefined when it has nothing new (the user must sign in).
   */
  reread(secrets: SecretStore, rejected: DeepSeekAuthPayload): Promise<DeepSeekAuthPayload | undefined> {
    this.rereading ??= this.readProfileSession(secrets, rejected).finally(() => {
      this.rereading = undefined;
    });
    return this.rereading;
  }

  private rereading: Promise<DeepSeekAuthPayload | undefined> | undefined;

  private async readProfileSession(
    secrets: SecretStore,
    rejected: DeepSeekAuthPayload,
  ): Promise<DeepSeekAuthPayload | undefined> {
    let context: BrowserContext | undefined;
    try {
      context = await launchPersistentProfile(browserDataDir(), { headless: true });
      const page = context.pages()[0] ?? (await context.newPage());
      // The app's first authenticated call carries the token it trusts.
      const captured = this.waitForAuthApiCall(context, REREAD_TIMEOUT_MS).catch(() => undefined);
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const token =
        normalizeToken(await captured) ??
        normalizeToken(await readLocalStorage(page, ["userToken", "token", "access_token"]));
      const cookieHeader = (await context.cookies(HOME_URL))
        .filter((c) => c?.name && typeof c.value === "string")
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      if (!token || !cookieHeader.includes("ds_session_id=")) {
        dlog.info("reread: the browser profile is signed out too");
        return undefined;
      }
      if (token === rejected.token && cookieHeader === rejected.cookieHeader) {
        dlog.info("reread: the browser profile holds the same refused session");
        return undefined;
      }
      const next = { token, cookieHeader };
      await secrets.store(AUTH_SECRET_KEY, JSON.stringify(next));
      dlog.info("reread: a live session from the browser profile stored");
      return next;
    } catch (err) {
      // A profile held by a sign-in window, a missing Chrome: the user signs in.
      dlog.warn(`reread: failed — ${errToString(err)}`);
      return undefined;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  async logout(secrets: SecretStore): Promise<void> {
    await secrets.delete(AUTH_SECRET_KEY);
    await rm(browserDataDir(), { recursive: true, force: true }).catch(
      () => {},
    );
    dlog.info("logout: token and browser profile cleared");
  }

  /**
   * Drops the sign-in after the server refused `rejected`. Matched on the
   * cookie session, the part every stored sign-in has; the Bearer is optional.
   */
  async forget(
    secrets: SecretStore,
    rejected: DeepSeekAuthPayload,
  ): Promise<void> {
    const matches = (stored: string) => {
      try {
        const parsed = JSON.parse(stored) as Partial<DeepSeekAuthPayload>;
        return String(parsed.cookieHeader ?? "").trim() === rejected.cookieHeader;
      } catch {
        return false;
      }
    };
    if (await forgetRejected(secrets, AUTH_SECRET_KEY, matches)) {
      dlog.info("forget: rejected session removed");
    }
  }

  async isAuthenticated(secrets: SecretStore): Promise<boolean> {
    return !!(await this.getAuth(secrets));
  }

  async getAuth(
    secrets: SecretStore,
  ): Promise<DeepSeekAuthPayload | undefined> {
    const raw = await secrets.get(AUTH_SECRET_KEY);
    if (!raw) return undefined;

    try {
      const parsed = JSON.parse(raw) as DeepSeekAuthPayload;
      const cookieHeader = String(parsed.cookieHeader ?? "").trim();
      if (!cookieHeader) {
        dlog.debug("getAuth: stored cookie empty");
        return undefined;
      }
      return { token: normalizeToken(parsed.token), cookieHeader };
    } catch (err) {
      dlog.warn(`getAuth: parse failed — ${errToString(err)}`);
      return undefined;
    }
  }

  /**
   * Resolves with the Bearer token of the first successful `/api/v0/` call —
   * the only reliable signal that sign-in actually completed.
   */
  private waitForAuthApiCall(
    context: BrowserContext,
    timeoutMs: number,
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const finish = (token?: string, err?: Error) => {
        clearTimeout(timer);
        context.off("response", onResponse);
        if (err) reject(err);
        else resolve(token);
      };

      const timer = setTimeout(
        () =>
          finish(
            undefined,
            new Error(
              `DeepSeek sign-in timeout (${Math.round(timeoutMs / 1000)}s). Complete sign-in in the opened window and try again.`,
            ),
          ),
        timeoutMs,
      );

      const onResponse = async (response: Response) => {
        try {
          if (
            !response.url().includes("/api/v0/") ||
            response.status() !== 200
          ) {
            return;
          }
          const headers = response.request().headers();
          const auth = headers["authorization"] ?? headers["Authorization"];
          if (!auth || !/^Bearer\s+\S{10,}/.test(auth)) return;

          const body = (await response.json()) as {
            code?: number;
            data?: { code?: number; biz_code?: number };
          };
          const code = body.code ?? body.data?.code;
          if (typeof code === "number" && code !== 0) return;
          if (
            typeof body.data?.biz_code === "number" &&
            body.data.biz_code !== 0
          ) {
            return;
          }

          finish(auth.replace(/^Bearer\s+/i, "").trim());
        } catch {
          // keep waiting
        }
      };

      context.on("response", onResponse);
    });
  }
}
