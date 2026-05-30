import { rm } from "fs/promises";
import * as os from "os";
import * as path from "path";
import { chromium } from "playwright";
import * as vscode from "vscode";

const TOKEN_SECRET_KEY = "ai-free-vscode.token";
const LEGACY_TOKEN_SECRET_KEYS = ["qwen-free.token"];
const QWEN_AUTH_URL = "https://chat.qwen.ai/auth?action=signin";
const QWEN_HOME_URL = "https://chat.qwen.ai";

/**
 * Постоянная директория профиля браузера.
 * Использует реальный Chrome, чтобы обойти блокировку Google OAuth
 * для автоматизированных браузеров.
 */
const BROWSER_DATA_DIR = path.join(
  os.homedir(),
  ".ai-free-vscode",
  "browser-profile",
);

export class QwenAuthManager {
  /**
   * Запускает реальный Chrome с постоянным профилем, открывает страницу авторизации Qwen.
   * Постоянный профиль позволяет Google OAuth работать корректно (не блокирует вход).
   * После успешного входа извлекает токен и закрывает браузер.
   */
  async login(secrets: vscode.SecretStorage): Promise<void> {
    const config = vscode.workspace.getConfiguration("freeAI");
    const timeoutMs = config.get<number>("playwright.timeout", 120000);

    // launchPersistentContext возвращает BrowserContext напрямую
    // channel: 'chrome' — использует системный Chrome вместо встроенного Chromium.
    // Это позволяет Google OAuth работать, так как Chrome не помечается как автоматизированный.
    // Fallback: если Chrome не установлен — используем встроенный Chromium.
    const browserContext = await this.launchContext(timeoutMs);

    const page = await browserContext.newPage();

    try {
      // Перехватываем Authorization header — самый надёжный способ получить токен
      let capturedToken: string | undefined;
      page.on("request", (request) => {
        if (capturedToken) return;
        const auth = request.headers()["authorization"];
        if (auth?.startsWith("Bearer eyJ")) {
          capturedToken = auth.slice("Bearer ".length);
        }
      });

      await page.goto(QWEN_AUTH_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // Ждём фактическое получение токена.
      // Это надёжнее, чем ждать конкретный URL, потому что OAuth может показывать
      // несколько промежуточных экранов и редиректов.
      const token = await this.waitForToken(
        page,
        timeoutMs,
        () => capturedToken,
      );

      if (!token) {
        throw new Error(
          "Не удалось извлечь токен авторизации после входа. Попробуйте ещё раз.",
        );
      }

      await secrets.store(TOKEN_SECRET_KEY, token);
    } finally {
      await browserContext.close();
    }
  }

  /**
   * Ожидает появления токена в request headers/localStorage/cookies.
   */
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

      // Пытаемся извлечь токен независимо от текущего URL
      // (evaluate может не сработать на чужом origin, но cookies/request могут сработать)
      const extracted = this.normalizeToken(await this.extractToken(page));
      if (extracted) {
        return extracted;
      }

      await page.waitForTimeout(700);
    }

    return undefined;
  }

  /**
   * Запускает браузер с постоянным профилем.
   * Сначала пробует реальный Chrome (channel: 'chrome'), при ошибке — встроенный Chromium.
   */
  private async launchContext(
    _timeoutMs: number,
  ): Promise<import("playwright").BrowserContext> {
    const launchOptions = {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
    };

    // Пробуем системный Chrome — он не блокируется Google OAuth
    try {
      return await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
        ...launchOptions,
        channel: "chrome",
      });
    } catch {
      // Chrome не установлен или не найден — падаем на встроенный Chromium
      // В этом случае Google OAuth может потребовать дополнительной верификации
      return await chromium.launchPersistentContext(
        BROWSER_DATA_DIR,
        launchOptions,
      );
    }
  }

  /**
   * Удаляет сохранённый токен.
   */
  async logout(secrets: vscode.SecretStorage): Promise<void> {
    // Текущий ключ
    await secrets.delete(TOKEN_SECRET_KEY);

    // legacy-ключи после переименования провайдера
    for (const key of LEGACY_TOKEN_SECRET_KEYS) {
      await secrets.delete(key);
    }

    // Дополнительно чистим persistent profile браузера,
    // чтобы следующий login не подтягивал старую веб-сессию автоматически.
    await rm(BROWSER_DATA_DIR, { recursive: true, force: true }).catch(
      () => {},
    );
  }

  /**
   * Проверяет наличие токена (без сетевого запроса).
   */
  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    const token = this.normalizeToken(await secrets.get(TOKEN_SECRET_KEY));
    return !!token;
  }

  /**
   * Возвращает сохранённый токен или undefined.
   */
  async getToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
    return this.normalizeToken(await secrets.get(TOKEN_SECRET_KEY));
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async extractToken(
    page: import("playwright").Page,
  ): Promise<string | undefined> {
    // Способ 1: localStorage (основной для chat.qwen.ai)
    const fromLocalStorage = await page
      .evaluate((): string | null => {
        // Ищем известные ключи, которые использует Qwen
        const keys = [
          "token",
          "__token",
          "accessToken",
          "access_token",
          "userToken",
        ];
        for (const key of keys) {
          const val = localStorage.getItem(key);
          if (val) {
            return val;
          }
        }

        // Перебираем все ключи localStorage в поиске чего-то похожего на JWT
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          const val = localStorage.getItem(key);
          if (val && val.startsWith("eyJ")) {
            return val;
          }
        }
        return null;
      })
      .catch(() => null);

    if (fromLocalStorage) {
      return fromLocalStorage;
    }

    // Способ 2: cookies
    const cookies = await page.context().cookies();
    const tokenCookie = cookies.find(
      (c) =>
        c.name === "token" ||
        c.name === "__token" ||
        c.name === "access_token" ||
        c.name === "Authorization",
    );
    if (tokenCookie) {
      return tokenCookie.value;
    }

    // request-header перехват уже работает в login() через page.on("request"),
    // поэтому здесь не инициируем принудительные перезагрузки страницы.
    return undefined;
  }

  /**
   * Приводит токен к чистому виду без Bearer/кавычек/JSON-обёрток.
   */
  private normalizeToken(raw?: string | null): string | undefined {
    if (!raw) return undefined;

    let token = raw.trim();

    // Частый кейс: "Bearer <token>"
    if (/^Bearer\s+/i.test(token)) {
      token = token.replace(/^Bearer\s+/i, "").trim();
    }

    // Убираем обрамляющие кавычки
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      token = token.slice(1, -1).trim();
    }

    // Если токен сохранён как JSON-строка/объект, пробуем распарсить
    if (token.startsWith("{") || token.startsWith("[")) {
      try {
        const parsed = JSON.parse(token) as
          | string
          | { token?: string; accessToken?: string; access_token?: string };
        if (typeof parsed === "string") {
          token = parsed;
        } else {
          token =
            parsed.token ?? parsed.accessToken ?? parsed.access_token ?? token;
        }
      } catch {
        // ignore
      }
    }

    return token || undefined;
  }
}
