import { rm } from "fs/promises";
import type { BrowserContext, Response } from "playwright";
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

const AUTH_SECRET_KEY = "ai-free-vscode.deepseek.auth";
const HOME_URL = "https://chat.deepseek.com";
const BROWSER_DATA_DIR = profileDir("deepseek-browser-profile");

const dlog = createLogger("deepseek-auth");

interface DeepSeekAuthPayload {
  token?: string;
  cookieHeader: string;
}

export class DeepSeekAuthManager {
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    dlog.info("login: opening browser");
    const context = await launchLoginContext(BROWSER_DATA_DIR);
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

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(AUTH_SECRET_KEY);
    await rm(BROWSER_DATA_DIR, { recursive: true, force: true }).catch(
      () => {},
    );
    dlog.info("logout: token and browser profile cleared");
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return !!(await this.getAuth(secrets));
  }

  async getAuth(
    secrets: vscode.SecretStorage,
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
