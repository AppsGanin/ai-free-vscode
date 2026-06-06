import { rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { chromium } from "playwright";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";

const AUTH_SECRET_KEY = "ai-free-vscode.deepseek.auth";
const DEEPSEEK_HOME_URL = "https://chat.deepseek.com";

const dlog = createLogger("deepseek-auth");

const BROWSER_DATA_DIR = path.join(
  os.homedir(),
  ".ai-free-vscode",
  "deepseek-browser-profile",
);

interface DeepSeekAuthPayload {
  token?: string;
  cookieHeader: string;
}

export class DeepSeekAuthManager {
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration("freeAI");
    const timeoutMs = config.get<number>("playwright.timeout", 120000);

    dlog.info("login: opening browser");
    const context = await this.launchContext();
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      // Чтобы не ловить ложный "успех" на старой сессии,
      // очищаем cookies до начала нового login-flow.
      await context.clearCookies().catch(() => undefined);

      dlog.debug(`login: navigating to ${DEEPSEEK_HOME_URL}`);
      await page.goto(DEEPSEEK_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Чистим local/session storage на origin перед ожиданием логина.
      await page
        .evaluate(() => {
          try {
            localStorage.clear();
          } catch {
            // ignore
          }
          try {
            sessionStorage.clear();
          } catch {
            // ignore
          }
        })
        .catch(() => undefined);

      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });

      dlog.info(
        `login: waiting for sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );
      const capturedToken = await this.waitForAuthApiCall(context, timeoutMs);
      const token =
        this.normalizeToken(capturedToken) ??
        (await this.waitForToken(page, 4000, () => undefined));

      const cookies = await context.cookies(DEEPSEEK_HOME_URL);
      const cookieHeader = this.cookiesToHeader(cookies);

      if (!cookieHeader.includes("ds_session_id=")) {
        dlog.warn("login: ds_session_id cookie missing (sign-in incomplete)");
        throw new Error(
          "Failed to get DeepSeek cookies (ds_session_id). Sign in and try again.",
        );
      }

      const payload: DeepSeekAuthPayload = {
        token: token || undefined,
        cookieHeader,
      };

      await secrets.store(AUTH_SECRET_KEY, JSON.stringify(payload));
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
    const auth = await this.getAuth(secrets);
    return !!auth?.cookieHeader;
  }

  async getAuth(
    secrets: vscode.SecretStorage,
  ): Promise<DeepSeekAuthPayload | undefined> {
    const raw = await secrets.get(AUTH_SECRET_KEY);
    if (!raw) {
      dlog.debug("getAuth: no stored auth");
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as DeepSeekAuthPayload;
      const token = this.normalizeToken(parsed.token);
      const cookieHeader = String(parsed.cookieHeader ?? "").trim();
      if (!cookieHeader) {
        dlog.debug("getAuth: stored cookie empty");
        return undefined;
      }
      return { token, cookieHeader };
    } catch (err) {
      dlog.warn(`getAuth: parse failed — ${errToString(err)}`);
      return undefined;
    }
  }

  private async launchContext(): Promise<import("playwright").BrowserContext> {
    const launchOptions = {
      headless: false,
      viewport: { width: 1280, height: 820 },
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
    };

    try {
      return await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
        ...launchOptions,
        channel: "chrome",
      });
    } catch {
      return await chromium.launchPersistentContext(
        BROWSER_DATA_DIR,
        launchOptions,
      );
    }
  }

  private async waitForToken(
    page: import("playwright").Page,
    timeoutMs: number,
    getCapturedToken: () => string | undefined,
  ): Promise<string | undefined> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const captured = this.normalizeToken(getCapturedToken());
      if (captured) {
        return captured;
      }

      const fromLocalStorage = this.normalizeToken(
        await page
          .evaluate(() => {
            try {
              return (
                localStorage.getItem("userToken") ??
                localStorage.getItem("token") ??
                localStorage.getItem("access_token")
              );
            } catch {
              return null;
            }
          })
          .catch(() => null),
      );

      if (fromLocalStorage) {
        return fromLocalStorage;
      }

      await page.waitForTimeout(700);
    }

    return undefined;
  }

  private waitForAuthApiCall(
    context: import("playwright").BrowserContext,
    timeoutMs: number,
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      let done = false;

      const cleanup = () => {
        context.off("response", onResponse);
      };

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(
          new Error(
            `DeepSeek sign-in timeout (${Math.round(timeoutMs / 1000)}s). Complete sign-in in the opened window and try again.`,
          ),
        );
      }, timeoutMs);

      const onResponse = async (response: import("playwright").Response) => {
        if (done) return;

        try {
          const url = response.url();
          if (!url.includes("/api/v0/")) {
            return;
          }
          if (response.status() !== 200) {
            return;
          }

          const reqHeaders = response.request().headers();
          const auth =
            reqHeaders["authorization"] ?? reqHeaders["Authorization"];
          if (!auth || !/^Bearer\s+\S{10,}/.test(auth)) {
            return;
          }

          let body: unknown;
          try {
            body = await response.json();
          } catch {
            return;
          }

          const payload = body as {
            code?: number;
            data?: { code?: number; biz_code?: number };
          };

          const code = payload.code ?? payload.data?.code;
          const bizCode = payload.data?.biz_code;

          if (typeof code === "number" && code !== 0) {
            return;
          }
          if (typeof bizCode === "number" && bizCode !== 0) {
            return;
          }

          done = true;
          clearTimeout(timer);
          cleanup();
          resolve(auth.replace(/^Bearer\s+/i, "").trim());
        } catch {
          // ignore and keep waiting
        }
      };

      context.on("response", onResponse);
    });
  }

  private cookiesToHeader(
    cookies: Array<{ name: string; value: string }>,
  ): string {
    return cookies
      .filter((c) => c?.name && typeof c.value === "string")
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  private normalizeToken(raw?: string | null): string | undefined {
    if (!raw) return undefined;

    let token = String(raw).trim();
    if (!token) return undefined;

    if (/^Bearer\s+/i.test(token)) {
      token = token.replace(/^Bearer\s+/i, "").trim();
    }

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
          | { value?: string; token?: string; access_token?: string };
        if (typeof parsed === "string") {
          token = parsed;
        } else {
          token = parsed.value ?? parsed.token ?? parsed.access_token ?? token;
        }
      } catch {
        // ignore
      }
    }

    return token || undefined;
  }
}
