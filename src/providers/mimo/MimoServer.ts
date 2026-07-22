import { randomBytes } from "crypto";
import { ChildProcess, spawn } from "child_process";
import { createLogger, errToString } from "../../logger";
import { ProviderError } from "../types";
import { cliEnv, mimoWorkDir, resolveMimoBinary } from "./MimoCli";

const slog = createLogger("mimo-server");

const PROVIDER_ID = "ai-free-vscode-mimo";
const STARTUP_TIMEOUT_MS = 60000;
/** Через сколько простоя гасим сервер, чтобы не держать процесс зря. */
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
/** Сколько ждём уборку сессий перед убийством процесса сервера. */
const STOP_GRACE_MS = 3000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const AGENT_NAME = "free-ai-vscode-chat";

/**
 * Системный промпт агента-моста. Инструменты у агента выключены полностью:
 * всю агентную работу (чтение файлов, правки, tool calls) ведёт Copilot Chat,
 * mimocode тут — только транспорт до модели.
 */
const AGENT_PROMPT = [
  "You are a chat model accessed through an editor extension.",
  "You have NO tools available: never emit tool calls, never mention tools.",
  "Answer the user's request directly and completely in markdown.",
  "Follow any instructions and protocols given in the user message itself.",
].join(" ");

export interface MimoServerHandle {
  url: string;
  /** Готовый заголовок Basic-авторизации локального сервера. */
  authHeader: string;
  /** Рабочая директория сессий (нейтральная, вне проекта пользователя). */
  directory: string;
}

/**
 * Управляет фоновым процессом `mimo serve` — headless-сервером mimocode.
 *
 * Почему сервер, а не `mimo run` на каждый запрос: `run` печатает готовый ответ
 * одним куском (стриминга нет), а серверный SSE `/event` отдаёт дельты токен за
 * токеном плюс умеет отмену запроса. Учётные данные при этом остаются у CLI —
 * ни ключей, ни токенов расширение не хранит.
 */
export class MimoServer {
  private handle?: MimoServerHandle;
  private proc?: ChildProcess;
  private starting?: Promise<MimoServerHandle>;
  private idleTimer?: NodeJS.Timeout;
  private beforeStop?: () => Promise<void>;
  private disposed = false;

  /** Запускает сервер (или переиспользует уже запущенный) и возвращает адрес. */
  async ensure(): Promise<MimoServerHandle> {
    if (this.disposed) {
      throw new ProviderError(PROVIDER_ID, "MiMo provider is disposed");
    }
    this.touch();

    if (this.handle && this.proc && !this.proc.killed) {
      return this.handle;
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Продлевает время жизни сервера (вызывается на каждом запросе). */
  touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      slog.info("idle timeout — stopping server");
      this.stop();
    }, IDLE_SHUTDOWN_MS);
    // Таймер не должен держать процесс расширения живым.
    this.idleTimer.unref?.();
  }

  private async start(): Promise<MimoServerHandle> {
    const bin = await resolveMimoBinary();
    if (!bin) {
      throw new ProviderError(
        PROVIDER_ID,
        "MiMo CLI not found. Install it (npm i -g @mimo-ai/cli) and sign in with `mimo`.",
      );
    }

    const directory = await mimoWorkDir();

    const username = "free-ai-vscode";
    const password = randomBytes(24).toString("hex");

    const env = cliEnv({
      MIMOCODE_SERVER_USERNAME: username,
      MIMOCODE_SERVER_PASSWORD: password,
      MIMOCODE_CONFIG_CONTENT: JSON.stringify(this.buildConfig()),
    });

    slog.info(`starting: ${bin} serve`);
    const proc = spawn(
      bin,
      ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.proc = proc;

    proc.on("exit", (code, signal) => {
      slog.info(`server exited code=${code} signal=${signal}`);
      if (this.proc === proc) {
        this.proc = undefined;
        this.handle = undefined;
      }
    });
    proc.on("error", (err) => {
      slog.error(`spawn error — ${errToString(err)}`);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        slog.debug(`stderr: ${text.slice(0, 400)}`);
      }
    });

    try {
      const url = await this.waitForUrl(proc);
      const handle: MimoServerHandle = {
        url,
        authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        directory,
      };
      this.handle = handle;
      slog.info(`ready at ${url}`);
      return handle;
    } catch (err) {
      proc.kill();
      this.proc = undefined;
      throw err;
    }
  }

  /** Ждёт строку «listening on http://…» в stdout сервера. */
  private waitForUrl(proc: ChildProcess): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let buffer = "";
      let settled = false;

      const timer = setTimeout(() => {
        finish(
          undefined,
          new ProviderError(PROVIDER_ID, "MiMo CLI server did not start in time"),
        );
      }, STARTUP_TIMEOUT_MS);

      const finish = (url?: string, err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        proc.off("exit", onExit);
        if (url) {
          resolve(url);
        } else {
          reject(err ?? new ProviderError(PROVIDER_ID, "MiMo CLI server failed"));
        }
      };

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        slog.debug(`stdout: ${chunk.toString("utf8").trim().slice(0, 200)}`);
        const match = /https?:\/\/[\w.-]+:\d+/.exec(buffer);
        if (match) {
          finish(match[0]);
        }
      };

      const onExit = (code: number | null) => {
        finish(
          undefined,
          new ProviderError(
            PROVIDER_ID,
            `MiMo CLI server exited before start (code=${code}). Run \`mimo\` in a terminal to finish setup.`,
          ),
        );
      };

      proc.stdout?.on("data", onData);
      proc.on("exit", onExit);
    });
  }

  /**
   * Конфиг, который отдаём серверу через MIMOCODE_CONFIG_CONTENT: единственный
   * агент без инструментов. Пользовательский `mimocode.jsonc` не трогаем —
   * авторизация лежит отдельно (data-dir), поэтому логин CLI продолжает работать.
   */
  private buildConfig(): Record<string, unknown> {
    return {
      $schema: "https://mimo.xiaomi.com/mimocode/config.json",
      autoupdate: false,
      share: "disabled",
      agent: {
        [AGENT_NAME]: {
          description: "Plain chat bridge for AI Free VSCode",
          mode: "primary",
          prompt: AGENT_PROMPT,
          tools: { "*": false },
        },
      },
    };
  }

  /** Имя агента, под которым шлём сообщения. */
  get agent(): string {
    return AGENT_NAME;
  }

  /**
   * Хук уборки, который успевает отработать до убийства процесса. Клиент
   * удаляет одноразовые сессии в фоне, и без этой паузы последний DELETE
   * не долетал — сессия навсегда оставалась в базе mimocode.
   */
  setBeforeStop(hook: () => Promise<void>): void {
    this.beforeStop = hook;
  }

  stop(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const proc = this.proc;
    this.proc = undefined;
    this.handle = undefined;
    if (!proc || proc.killed) {
      return;
    }

    slog.info("stopping server");
    const cleanup = this.beforeStop?.() ?? Promise.resolve();
    // Ждём уборку, но недолго: висящий сервер хуже осиротевшей сессии.
    void Promise.race([cleanup.catch(() => undefined), delay(STOP_GRACE_MS)])
      .catch(() => undefined)
      .finally(() => {
        if (!proc.killed) {
          proc.kill();
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}
