import { rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { chromium } from "playwright";
import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";

const AUTH_SECRET_KEY = "ai-free-vscode.kimi.auth";
const KIMI_HOME_URL = "https://www.kimi.com";

const klog = createLogger("kimi-auth");

const BROWSER_DATA_DIR = path.join(
  os.homedir(),
  ".ai-free-vscode",
  "kimi-browser-profile",
);

export interface KimiAuthPayload {
  /** JWT access token (Bearer) */
  token: string;
}

export class KimiAuthManager {
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration("freeAI");
    const timeoutMs = config.get<number>("playwright.timeout", 120000);

    klog.info("login: opening browser");
    const context = await this.launchContext();
    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await context.clearCookies().catch(() => undefined);

      // Перехватываем Authorization header к apiv2. ВАЖНО: kimi.com выдаёт
      // гостевой токен сразу при загрузке, поэтому держим ПОСЛЕДНИЙ токен
      // (после логина он сменится на токен реального аккаунта).
      let capturedToken: string | undefined;
      page.on("request", (request) => {
        const url = request.url();
        if (!url.includes("kimi.com")) return;
        const auth = request.headers()["authorization"];
        if (auth?.startsWith("Bearer eyJ")) {
          capturedToken = auth.slice("Bearer ".length).trim();
        }
      });

      klog.debug(`login: navigating to ${KIMI_HOME_URL}`);
      await page.goto(KIMI_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      klog.info(
        `login: waiting for non-guest sign-in (timeout=${Math.round(timeoutMs / 1000)}s)`,
      );
      const token = await this.waitForLoggedInToken(
        page,
        timeoutMs,
        () => capturedToken,
      );

      if (!token) {
        klog.warn("login: sign-in not detected within timeout (still guest)");
        throw new Error(
          "Kimi: sign-in not detected. Log in to your account in the opened window (a guest session is not enough) and try again.",
        );
      }

      const payload: KimiAuthPayload = { token };
      await secrets.store(AUTH_SECRET_KEY, JSON.stringify(payload));
      klog.info("login: success, token stored");
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

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    const auth = await this.getAuth(secrets);
    return !!auth?.token;
  }

  async getAuth(
    secrets: vscode.SecretStorage,
  ): Promise<KimiAuthPayload | undefined> {
    const raw = await secrets.get(AUTH_SECRET_KEY);
    if (!raw) {
      klog.debug("getAuth: no stored token");
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as KimiAuthPayload;
      const token = this.normalizeToken(parsed.token);
      if (!token) {
        klog.debug("getAuth: stored token invalid");
        return undefined;
      }
      return { token };
    } catch (err) {
      klog.warn(`getAuth: parse failed — ${errToString(err)}`);
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

  /**
   * Ждёт токен РЕАЛЬНОГО аккаунта. Признак: токен проходит проверку в API Kimi
   * (GetSubscription возвращает подписку только для залогиненного пользователя;
   * гостевой/невалидный токен — 401/без подписки).
   */
  private async waitForLoggedInToken(
    page: import("playwright").Page,
    timeoutMs: number,
    getCapturedToken: () => string | undefined,
  ): Promise<string | undefined> {
    const startedAt = Date.now();
    let lastChecked: string | undefined;

    while (Date.now() - startedAt < timeoutMs) {
      const candidate =
        this.normalizeToken(getCapturedToken()) ??
        this.normalizeToken(
          await page
            .evaluate(() => {
              try {
                return (
                  localStorage.getItem("access_token") ??
                  localStorage.getItem("token")
                );
              } catch {
                return null;
              }
            })
            .catch(() => null),
        );

      // Перепроверяем только сменившийся токен, чтобы не спамить API.
      if (candidate && candidate !== lastChecked) {
        lastChecked = candidate;
        klog.debug("login: validating candidate token via GetSubscription");
        if (await this.isLoggedInToken(page, candidate)) {
          klog.info("login: token validated (logged-in account)");
          return candidate;
        }
        klog.debug("login: candidate rejected (guest/invalid token)");
      }

      await page.waitForTimeout(900);
    }

    return undefined;
  }

  /** Проверяет токен через API Kimi (внутри страницы — с её origin/cookies). */
  private async isLoggedInToken(
    page: import("playwright").Page,
    token: string,
  ): Promise<boolean> {
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
    if (token.startsWith("{")) {
      try {
        const parsed = JSON.parse(token) as {
          token?: string;
          access_token?: string;
          value?: string;
        };
        token = parsed.access_token ?? parsed.token ?? parsed.value ?? token;
      } catch {
        // ignore
      }
    }

    return token.startsWith("eyJ") ? token : undefined;
  }
}
