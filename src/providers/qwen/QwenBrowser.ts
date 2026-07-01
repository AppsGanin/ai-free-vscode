import * as os from "os";
import * as path from "path";
import { chromium } from "playwright";

/**
 * Постоянная директория профиля браузера.
 * В ней Chromium хранит cookies живой сессии Qwen — их использует и авторизация,
 * и браузерный fallback при блокировке Aliyun WAF.
 */
export const BROWSER_DATA_DIR = path.join(
  os.homedir(),
  ".ai-free-vscode",
  "browser-profile",
);

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
];

// Уводим окно далеко за пределы экрана: браузер остаётся headed (рендеринг и
// фингерпринт настоящие — анти-бот не срабатывает), но не мешает пользователю.
const OFFSCREEN_ARGS = ["--window-position=-32000,-32000"];

/**
 * Запускает persistent-context на общем профиле.
 * Сначала пробует системный Chrome (channel: "chrome") — у него «настоящий»
 * TLS/JA3-фингерпринт, который проходит Aliyun WAF и не блокируется Google OAuth;
 * при его отсутствии — встроенный Chromium.
 */
export async function launchQwenContext(options: {
  headless: boolean;
  /**
   * "block" — запретить service workers. У chat.qwen.ai есть SW, который в
   * фоновом мосте перехватывает API-fetch и подвешивает его; для моста блокируем.
   */
  serviceWorkers?: "allow" | "block";
  /** Увести окно за экран (для фонового моста; логин оставляем видимым). */
  offscreen?: boolean;
}): Promise<import("playwright").BrowserContext> {
  const launchOptions = {
    headless: options.headless,
    viewport: { width: 1280, height: 800 },
    args: options.offscreen ? [...LAUNCH_ARGS, ...OFFSCREEN_ARGS] : LAUNCH_ARGS,
    serviceWorkers: options.serviceWorkers ?? "allow",
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
