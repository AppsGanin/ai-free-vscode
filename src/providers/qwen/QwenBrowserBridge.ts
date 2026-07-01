import type { BrowserContext, Page } from "playwright";
import { createLogger, errToString } from "../../logger";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { launchQwenContext } from "./QwenBrowser";

const PROVIDER_ID = "ai-free-vscode";
const QWEN_HOME_URL = "https://chat.qwen.ai";
const SINK_BINDING = "__qwenSseSink";
// Прикладные заголовки веб-приложения (см. qwenAppHeaders в QwenApiClient).
const QWEN_WEB_VERSION = "0.2.68";
const QWEN_BX_V = "2.5.36";

// Таймауты, чтобы мост никогда не «висел» бесконечно, а падал с внятной ошибкой.
const LAUNCH_TIMEOUT_MS = 45000;
const NAV_TIMEOUT_MS = 20000;
// Сколько ждём авто-снятия WAF-челленджа (вычисление cookie + перезагрузка).
const WAF_CLEAR_TIMEOUT_MS = 15000;
// Ожидание ПЕРВОГО ответа от fetch; дольше — считаем зависшим (враждебный
// headless) и эскалируем. TTFB у рабочего запроса — секунды.
const IN_PAGE_FETCH_TIMEOUT_MS = 15000;
// Сколько ждём, пока пользователь решит интерактивную капчу в окне.
const MANUAL_CAPTCHA_TIMEOUT_MS = 120000;
// Ответ пришёл, но новых событий стрима нет так долго — считаем зависанием.
const STREAM_IDLE_TIMEOUT_MS = 120000;
const POST_JSON_TIMEOUT_MS = 45000;

const blog = createLogger("qwen-browser");

type SinkEvent =
  | {
      t: "head";
      status: number;
      contentType: string;
      retryAfter: string | null;
    }
  | { t: "waf" }
  | { t: "chunk"; data: string }
  | { t: "end" }
  | { t: "error"; message: string };

/** wafHit — ответ был WAF/анти-бот челленджем; yielded — наружу уже пошли чанки. */
interface RunState {
  wafHit: boolean;
  yielded: boolean;
}

export interface BrowserStreamOptions {
  url: string;
  token: string;
  body: unknown;
  /** Для заголовка Referer (страница чата), если известен chat_id. */
  chatId?: string;
  abortSignal?: AbortSignal;
}

/**
 * Выполняет запросы к Qwen в обход Aliyun WAF, используя реальную браузерную сессию.
 *
 * WAF фингерпринтит сетевой стек: проходит только сам Chromium, а Node-стек
 * (обычный fetch / context.request) заворачивается даже с clearance-cookie.
 * Поэтому запросы идут через `page.evaluate` в контексте chat.qwen.ai.
 *
 * Страница враждебна к автоматизации и переопределяет `window.fetch`
 * (наш прямой fetch из-за этого зависал). Обход: берём «чистый» `fetch` из
 * свежего same-origin `<iframe>` — он не тронут скриптами страницы, но использует
 * тот же браузерный стек и cookies.
 *
 * Одна тёплая вкладка; запросы сериализуются мьютексом (один активный sink).
 */
export class QwenBrowserBridge {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private activeSink: ((ev: SinkEvent) => void) | null = null;
  private mutexChain: Promise<void> = Promise.resolve();

  // Режим окна моста (см. конструктор):
  //  - "headed"   — всегда видимое/свёрнутое окно;
  //  - "headless" — всегда без окна, без эскалации;
  //  - "auto"     — пробуем headless (со стелсом), при детекте анти-бота один раз
  //                 эскалируем в headed.
  private mode: "headless" | "headed";
  private readonly canEscalate: boolean;

  /**
   * @param notifyCaptcha — колбэк, показывающий пользователю сообщение о
   * необходимости пройти капчу (провайдер прокидывает vscode-нотификацию).
   */
  constructor(
    private readonly notifyCaptcha?: (message: string) => void,
    configuredMode: "auto" | "headed" | "headless" = "auto",
  ) {
    // Env-переменные имеют приоритет над настройкой.
    const resolved =
      process.env.QWEN_BRIDGE_HEADED === "1"
        ? "headed"
        : process.env.QWEN_BRIDGE_HEADLESS === "1"
          ? "headless"
          : configuredMode;
    this.mode = resolved === "headed" ? "headed" : "headless";
    this.canEscalate = resolved === "auto";
  }

  /**
   * Стримит chat/completions через браузер, отдавая сырые SSE-строки —
   * тот же формат, что и прямой ответ, чтобы их парсил общий `parseSSEText`.
   */
  async *streamChat(opts: BrowserStreamOptions): AsyncIterable<string> {
    const release = await this.acquire();
    try {
      // Пока наружу не отдан ни один чанк (state.yielded=false), запрос можно
      // безопасно повторить: и WAF, и зависание случаются до первого чанка.
      const state: RunState = { wafHit: false, yielded: false };

      // Первый прогон в текущем режиме. В headless враждебная страница может
      // подвесить fetch — трактуем такое зависание/ошибку как блок и эскалируем.
      let blocked = false;
      try {
        yield* this.runBrowserStream(await this.ensurePage(), opts, state);
        blocked = state.wafHit;
      } catch (err) {
        if (state.yielded || !(this.canEscalate && this.mode === "headless")) {
          throw err;
        }
        blog.warn(`headless attempt failed: ${errToString(err)}`);
        blocked = true;
      }

      // headless задетектили → эскалируем в headed и пробуем ещё раз.
      if (blocked && this.canEscalate && this.mode === "headless") {
        blog.info("headless bridge blocked by anti-bot, escalating to headed");
        await this.relaunchHeaded();
        yield* this.runBrowserStream(await this.ensurePage(), opts, state);
      }

      // Всё ещё блок → одна перечистка clearance-cookie (кейс её истечения).
      if (state.wafHit) {
        blog.info("stream hit WAF, re-clearing cookie and retrying once");
        await this.navigateAndClearWaf(this.page as Page, true);
        yield* this.runBrowserStream(this.page as Page, opts, state);
      }

      // Всё ещё блок → интерактивная капча. Разворачиваем окно и ждём, пока
      // пользователь решит её, затем повторяем сам запрос автоматически.
      if (state.wafHit) {
        yield* this.solveCaptchaAndRetry(opts, state);
      }
    } finally {
      release();
    }
  }

  /**
   * Разворачивает окно, просит решить капчу, ждёт снятия челленджа и повторяет
   * запрос. Если не решено в отведённое время — бросает понятную ошибку.
   */
  private async *solveCaptchaAndRetry(
    opts: BrowserStreamOptions,
    state: RunState,
  ): AsyncIterable<string> {
    const page = this.page as Page;
    await this.revealForCaptcha();
    const solved = await this.waitForWafClear(page, MANUAL_CAPTCHA_TIMEOUT_MS);
    if (solved) {
      blog.info("captcha solved by user, retrying request");
      await this.minimizeWindow(page).catch(() => undefined);
      yield* this.runBrowserStream(page, opts, state);
    }
    if (state.wafHit) {
      throw new ProviderError(
        PROVIDER_ID,
        "Qwen anti-bot challenge — solve the captcha in the browser window, then send your request again",
      );
    }
  }

  /** Переоткрывает мост в headed-режиме (после детекта headless). */
  private async relaunchHeaded(): Promise<void> {
    this.mode = "headed";
    await this.close();
  }

  /**
   * Выдвигает скрытое за экран окно моста на экран и фокусит вкладку, чтобы
   * пользователь мог пройти капчу. Показывает vscode-уведомление.
   */
  private async revealForCaptcha(): Promise<void> {
    const page = this.page;
    const context = this.context;
    if (page && context) {
      try {
        const cdp = await context.newCDPSession(page);
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        // Из свёрнутого/минимизированного окна сперва возвращаем normal,
        // затем задаём положение и размер отдельным вызовом.
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal" },
        });
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 80, top: 80, width: 1100, height: 820 },
        });
        await page.bringToFront();
      } catch (err) {
        blog.warn(`revealForCaptcha failed: ${errToString(err)}`);
      }
    }
    this.notifyCaptcha?.(
      "Qwen requires a one-time verification. Solve the captcha in the opened browser window, then send your request again.",
    );
  }

  private async *runBrowserStream(
    page: Page,
    opts: BrowserStreamOptions,
    state: RunState,
  ): AsyncIterable<string> {
    state.wafHit = false;
    const events: SinkEvent[] = [];
    let notify: (() => void) | null = null;
    this.activeSink = (ev) => {
      events.push(ev);
      const n = notify;
      notify = null;
      n?.();
    };

    const abortInPage = () => {
      page
        .evaluate(() => {
          (window as unknown as { __qwenAbort?: () => void }).__qwenAbort?.();
        })
        .catch(() => undefined);
    };
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        abortInPage();
      } else {
        opts.abortSignal.addEventListener("abort", abortInPage);
      }
    }

    const runPromise = page
      .evaluate(BROWSER_FETCH_FN, {
        url: opts.url,
        token: opts.token,
        bodyJson: JSON.stringify(opts.body),
        referer: opts.chatId
          ? `${QWEN_HOME_URL}/c/${opts.chatId}`
          : `${QWEN_HOME_URL}/`,
        sinkName: SINK_BINDING,
        idleTimeoutMs: IN_PAGE_FETCH_TIMEOUT_MS,
        webVersion: QWEN_WEB_VERSION,
        bxV: QWEN_BX_V,
      })
      .catch((err) => {
        this.activeSink?.({ t: "error", message: errToString(err) });
      });

    try {
      let finished = false;
      while (!finished) {
        if (events.length === 0) {
          await withTimeout(
            new Promise<void>((resolve) => {
              notify = resolve;
            }),
            STREAM_IDLE_TIMEOUT_MS,
            "stream idle",
          );
        }
        while (events.length > 0) {
          const ev = events.shift() as SinkEvent;
          switch (ev.t) {
            case "head":
              if (ev.status === 401) {
                throw new AuthExpiredError(PROVIDER_ID);
              }
              if (ev.status === 429) {
                throw new RateLimitError(
                  PROVIDER_ID,
                  ev.retryAfter
                    ? parseInt(ev.retryAfter, 10) * 1000
                    : undefined,
                );
              }
              blog.debug(
                `stream head status=${ev.status} contentType=${ev.contentType}`,
              );
              break;
            case "waf":
              // Ответ — HTML-челлендж WAF. Прекращаем без throw: внешний
              // streamChat перечистит cookie и повторит один раз.
              state.wafHit = true;
              finished = true;
              break;
            case "chunk":
              state.yielded = true;
              yield ev.data;
              break;
            case "end":
              finished = true;
              break;
            case "error":
              throw new ProviderError(PROVIDER_ID, ev.message);
          }
        }
      }
    } finally {
      if (opts.abortSignal) {
        opts.abortSignal.removeEventListener("abort", abortInPage);
      }
      // Если консьюмер прервал чтение раньше времени (стоп-страж парсера) —
      // останавливаем и in-page fetch, чтобы не держать апстрим.
      abortInPage();
      this.activeSink = null;
      await runPromise.catch(() => undefined);
    }
  }

  /**
   * POST c JSON-ответом (например, создание чата) через браузерную сессию.
   */
  async postJson(
    url: string,
    token: string,
    body: unknown,
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const release = await this.acquire();
    try {
      const bodyJson = JSON.stringify(body);
      const page = await this.ensurePage();

      const runOnce = async () => {
        blog.debug("postJson evaluate start");
        const result = await withTimeout(
          page.evaluate(BROWSER_JSON_FN, {
            url,
            token,
            bodyJson,
            timeoutMs: IN_PAGE_FETCH_TIMEOUT_MS,
            webVersion: QWEN_WEB_VERSION,
            bxV: QWEN_BX_V,
          }),
          POST_JSON_TIMEOUT_MS,
          "postJson",
        );
        blog.debug(`postJson done ok=${result.ok} status=${result.status}`);
        return result;
      };

      let result = await runOnce();
      // Clearance-cookie на тёплой вкладке мог истечь — перечищаем WAF и повторяем.
      if (isWafHtml(result.text)) {
        blog.info(
          "postJson hit WAF on warm page, re-clearing and retrying once",
        );
        await this.navigateAndClearWaf(page, true);
        result = await runOnce();
      }

      if (isWafHtml(result.text)) {
        return { ok: false, status: result.status, text: result.text };
      }
      return result;
    } finally {
      release();
    }
  }

  /**
   * Читает актуальный Bearer-токен из живой сессии (localStorage).
   * Используется для тихого обновления протухшего токена без повторного входа.
   */
  async readToken(): Promise<string | undefined> {
    try {
      const page = await this.ensurePage();
      const raw = await page.evaluate(() => {
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
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key) continue;
          const val = localStorage.getItem(key);
          if (val && val.startsWith("eyJ")) {
            return val;
          }
        }
        return null;
      });
      return raw ?? undefined;
    } catch (err) {
      blog.warn(`readToken failed: ${errToString(err)}`);
      return undefined;
    }
  }

  /**
   * Закрывает браузер. Обязательно вызвать перед интерактивным логином:
   * persistent-профиль нельзя открыть двумя контекстами одновременно.
   */
  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    this.activeSink = null;
    if (ctx) {
      await ctx.close().catch(() => undefined);
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  /**
   * Простой мьютекс: возвращает функцию release, удерживая очередь запросов.
   */
  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const prev = this.mutexChain;
    this.mutexChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    return release;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }
    const headless = this.mode === "headless";
    blog.info(`launching browser bridge (mode=${this.mode})`);
    const context = await withTimeout(
      launchQwenContext({
        headless,
        serviceWorkers: "block",
        // headed-окно уводим за экран (Linux/Win); на macOS позиция клампится,
        // поэтому дополнительно сворачиваем окно после загрузки (см. ensurePage).
        offscreen: !headless,
      }),
      LAUNCH_TIMEOUT_MS,
      "launch",
    );
    // Стелс: маскируем признаки автоматизации/headless до загрузки страниц.
    await context.addInitScript(STEALTH_INIT).catch((err) => {
      blog.warn(`addInitScript failed: ${errToString(err)}`);
    });
    blog.info("browser bridge launched");
    context.on("close", () => {
      this.context = undefined;
      this.page = undefined;
    });
    this.context = context;
    return context;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }
    const context = await this.ensureContext();
    const page = await context.newPage();
    blog.debug("bridge page created");
    page.on("console", (msg) => blog.debug(`[page] ${msg.text()}`));
    page.on("pageerror", (err) =>
      blog.warn(`[page error] ${errToString(err)}`),
    );
    await page.exposeFunction(SINK_BINDING, (ev: SinkEvent) => {
      this.activeSink?.(ev);
    });
    const cleared = await this.navigateAndClearWaf(page, false);
    this.page = page;
    if (this.mode === "headed") {
      if (cleared) {
        // Челлендж снят — можно свернуть окно с глаз (на macOS это надёжнее,
        // чем off-screen; на капче revealForCaptcha его развернёт).
        await this.minimizeWindow(page);
      } else {
        // Челлендж НЕ снялся (вероятно интерактивная капча на самой странице) —
        // НЕ сворачиваем, а показываем окно, чтобы пользователь её решил.
        blog.warn("WAF challenge on page did not clear — revealing window");
        await this.revealForCaptcha();
      }
    }
    return page;
  }

  /** Сворачивает окно моста (headed) через CDP. */
  private async minimizeWindow(page: Page): Promise<void> {
    const context = this.context;
    if (!context) return;
    try {
      const cdp = await context.newCDPSession(page);
      const { windowId } = await cdp.send("Browser.getWindowForTarget");
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "minimized" },
      });
    } catch (err) {
      blog.warn(`minimizeWindow failed: ${errToString(err)}`);
    }
  }

  /**
   * Открывает/перезагружает главную и даёт JS-челленджу Aliyun WAF отработать:
   * он вычисляет clearance-cookie и перезагружает страницу. Без этого последующие
   * запросы снова получают HTML-челлендж вместо данных.
   */
  private async navigateAndClearWaf(
    page: Page,
    reload: boolean,
  ): Promise<boolean> {
    if (reload) {
      await page
        .reload({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
    } else {
      await page.goto(QWEN_HOME_URL, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
    }
    const cleared = await this.waitForWafClear(page, WAF_CLEAR_TIMEOUT_MS);
    blog.info(
      cleared
        ? "bridge page navigated, WAF cleared"
        : "bridge page navigated, but WAF challenge did not clear within timeout",
    );
    return cleared;
  }

  /** Ждёт исчезновения WAF-челленджа на странице. true — снят, false — таймаут. */
  private async waitForWafClear(page: Page, timeoutMs: number): Promise<boolean> {
    try {
      await page.waitForFunction(
        () => !document.querySelector('meta[name="aliyun_waf_aa"]'),
        undefined,
        { timeout: timeoutMs },
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Стелс-скрипт (context.addInitScript): маскирует типовые признаки
 * автоматизации/headless, чтобы анти-бот считал сессию доверенной и не требовал
 * капчу. Исполняется в каждом документе ДО скриптов страницы.
 */
const STEALTH_INIT = () => {
  const nav = navigator as unknown as Record<string, unknown>;
  const def = (obj: object, prop: string, value: unknown) => {
    try {
      Object.defineProperty(obj, prop, { get: () => value });
    } catch {
      /* ignore */
    }
  };

  def(nav, "webdriver", undefined);
  def(nav, "hardwareConcurrency", 8);
  def(nav, "deviceMemory", 8);
  def(nav, "languages", ["en-US", "en"]);
  // Непустой список плагинов (у headless он пустой — явный признак).
  def(nav, "plugins", [1, 2, 3, 4, 5]);

  const w = window as unknown as Record<string, unknown>;
  if (!w.chrome) {
    w.chrome = { runtime: {} };
  }

  // permissions.query для notifications у headless расходится с Notification.
  try {
    const perms = navigator.permissions as unknown as {
      query?: (d: { name: string }) => Promise<unknown>;
    };
    const orig = perms?.query?.bind(perms);
    if (orig) {
      perms.query = (d: { name: string }) =>
        d && d.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : orig(d);
    }
  } catch {
    /* ignore */
  }

  // WebGL vendor/renderer — headless часто выдаёт SwiftShader/Google.
  try {
    const proto = WebGLRenderingContext.prototype as unknown as {
      getParameter: (p: number) => unknown;
    };
    const getParam = proto.getParameter;
    proto.getParameter = function (this: unknown, p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParam.call(this, p);
    };
  } catch {
    /* ignore */
  }
};

/** Похоже ли тело ответа на HTML-челлендж Aliyun WAF, а не на данные API. */
function isWafHtml(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return head.includes("aliyun_waf") || head.includes("<!doctype");
}

/**
 * Ограничивает промис по времени: по таймауту — ProviderError (исходный промис
 * продолжает выполняться в фоне, но мы его больше не ждём).
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProviderError(
          PROVIDER_ID,
          `browser bridge timeout: ${label} (${ms}ms)`,
        ),
      );
    }, ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Тело функции, исполняемой ВНУТРИ страницы (сериализуется Playwright и
 * выполняется через CDP в обход CSP).
 * Стримит SSE обратно в Node через exposed-биндинг `sinkName`. Использует
 * `window.fetch` ГЛАВНОЙ страницы (как upstream) — чтобы запрос шёл в контексте
 * доверенной сессии/анти-бот-SDK, иначе completions отдаёт x5sec/RGV587.
 */
const BROWSER_FETCH_FN = async (args: {
  url: string;
  token: string;
  bodyJson: string;
  referer: string;
  sinkName: string;
  idleTimeoutMs: number;
  webVersion: string;
  bxV: string;
}): Promise<void> => {
  const w = window as unknown as Record<string, unknown>;
  const sink = w[args.sinkName] as (ev: SinkEvent) => Promise<void>;

  const controller = new AbortController();
  // Таймер гасит только ожидание первого ответа; после headers — снимаем.
  let waitTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(),
    args.idleTimeoutMs,
  );
  w.__qwenAbort = () => controller.abort();

  let resp: Response;
  try {
    resp = await window.fetch(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + args.token,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        source: "web",
        version: args.webVersion,
        "bx-v": args.bxV,
        "x-request-id": crypto.randomUUID(),
        timezone: new Date().toString().replace(/\s*\(.*\)\s*$/, ""),
      },
      body: args.bodyJson,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (e) {
    if (waitTimer) clearTimeout(waitTimer);
    await sink({ t: "error", message: String((e as Error)?.message ?? e) });
    return;
  }
  if (waitTimer) {
    clearTimeout(waitTimer);
    waitTimer = undefined;
  }

  const contentType = resp.headers.get("content-type") ?? "";
  await sink({
    t: "head",
    status: resp.status,
    contentType,
    retryAfter: resp.headers.get("retry-after"),
  });

  // completions обязан вернуть SSE. Не-event-stream = WAF/анти-бот (html или
  // x5sec/RGV587 в JSON). Сигналим 'waf' — внешний код перечистит и повторит.
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    if (
      contentType.toLowerCase().includes("text/html") ||
      /FAIL_SYS_USER_VALIDATE|RGV587|x5sec|_____tmd_____|\/punish/i.test(text)
    ) {
      await sink({ t: "waf" });
      return;
    }
    await sink({
      t: "error",
      message: "Non-SSE " + resp.status + ": " + text.slice(0, 300),
    });
    return;
  }

  if (!resp.ok) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    await sink({
      t: "error",
      message: "HTTP " + resp.status + ": " + text.slice(0, 300),
    });
    return;
  }

  if (!resp.body) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    if (text) {
      await sink({ t: "chunk", data: text });
    }
    await sink({ t: "end" });
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.length) {
        await sink({
          t: "chunk",
          data: decoder.decode(value, { stream: true }),
        });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      await sink({ t: "chunk", data: tail });
    }
    await sink({ t: "end" });
  } catch (e) {
    await sink({ t: "error", message: String((e as Error)?.message ?? e) });
  }
};

/**
 * In-page POST c буферизованным JSON-ответом (чистый fetch из iframe).
 */
const BROWSER_JSON_FN = async (args: {
  url: string;
  token: string;
  bodyJson: string;
  timeoutMs: number;
  webVersion: string;
  bxV: string;
}): Promise<{ ok: boolean; status: number; text: string }> => {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  frame.src = "about:blank";
  document.documentElement.appendChild(frame);
  const cw = frame.contentWindow as (Window & typeof globalThis) | null;
  const cleanFetch = (cw?.fetch ?? window.fetch).bind(cw ?? window);
  const CleanAbort = cw?.AbortController ?? AbortController;
  const cleanupFrame = () => {
    try {
      frame.remove();
    } catch {
      /* ignore */
    }
  };

  const controller = new CleanAbort();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const resp = await cleanFetch(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + args.token,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        source: "web",
        version: args.webVersion,
        "bx-v": args.bxV,
        "x-request-id": crypto.randomUUID(),
        timezone: new Date().toString().replace(/\s*\(.*\)\s*$/, ""),
      },
      body: args.bodyJson,
      credentials: "include",
      signal: controller.signal,
    });
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    return { ok: resp.ok, status: resp.status, text };
  } catch (e) {
    return { ok: false, status: 0, text: String((e as Error)?.message ?? e) };
  } finally {
    clearTimeout(timer);
    cleanupFrame();
  }
};
