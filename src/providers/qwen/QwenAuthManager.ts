import { rm } from "fs/promises";
import type { Page } from "playwright";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";
import {
  loginTimeoutMs,
  normalizeToken,
  pollForToken,
} from "../common/browserAuth";
import { BROWSER_DATA_DIR, launchQwenContext } from "./QwenBrowser";

const TOKEN_SECRET_KEY = "ai-free-vscode.qwen.token";
const AUTH_URL = "https://chat.qwen.ai/auth?action=signin";
const TOKEN_KEYS = [
  "token",
  "__token",
  "accessToken",
  "access_token",
  "userToken",
];

const qlog = createLogger("qwen-auth");

export class QwenAuthManager {
  /**
   * Opens the sign-in page in a real browser with a persistent profile (Google
   * OAuth refuses automated ones), waits for a token and closes the window.
   */
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const timeoutMs = loginTimeoutMs();
    qlog.info("login: opening browser");
    const context = await launchQwenContext({ headless: false });
    const page = await context.newPage();

    try {
      // Intercepting the Authorization header is the most reliable source;
      // OAuth walks through several intermediate screens and redirects.
      let capturedToken: string | undefined;
      page.on("request", (request) => {
        if (capturedToken) return;
        const auth = request.headers()["authorization"];
        if (auth?.startsWith("Bearer eyJ")) {
          capturedToken = auth.slice("Bearer ".length);
        }
      });

      await page.goto(AUTH_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      qlog.info(
        `login: waiting for sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );
      const token = await pollForToken(page, timeoutMs, 700, async () =>
        normalizeToken(capturedToken ?? (await this.extractToken(page))),
      );

      if (!token) {
        qlog.warn("login: token not captured within timeout");
        throw new Error(
          "Failed to extract the auth token after sign-in. Try again.",
        );
      }

      await secrets.store(TOKEN_SECRET_KEY, token);
      qlog.info("login: success, token stored");
    } catch (err) {
      qlog.error(`login: failed — ${errToString(err)}`);
      throw err;
    } finally {
      await context.close();
    }
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(TOKEN_SECRET_KEY);
    // Also drop the browser profile so the next login does not silently reuse
    // the old web session.
    await rm(BROWSER_DATA_DIR, { recursive: true, force: true }).catch(
      () => {},
    );
    qlog.info("logout: token and browser profile cleared");
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return !!(await this.getToken(secrets));
  }

  async getToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
    return normalizeToken(await secrets.get(TOKEN_SECRET_KEY));
  }

  /** Stores a token refreshed from the live browser session. */
  async saveToken(
    secrets: vscode.SecretStorage,
    raw: string | undefined,
  ): Promise<string | undefined> {
    const token = normalizeToken(raw);
    if (token) await secrets.store(TOKEN_SECRET_KEY, token);
    return token;
  }

  private async extractToken(page: Page): Promise<string | undefined> {
    const fromStorage = await page
      .evaluate((keys: string[]) => {
        for (const key of keys) {
          const value = localStorage.getItem(key);
          if (value) return value;
        }
        // Any JWT-looking value will do — Qwen renames its key now and then.
        for (let i = 0; i < localStorage.length; i++) {
          const value = localStorage.getItem(localStorage.key(i) ?? "");
          if (value?.startsWith("eyJ")) return value;
        }
        return null;
      }, TOKEN_KEYS)
      .catch(() => null);
    if (fromStorage) return fromStorage;

    const cookies = await page.context().cookies();
    return cookies.find(
      (c) => TOKEN_KEYS.includes(c.name) || c.name === "Authorization",
    )?.value;
  }
}
