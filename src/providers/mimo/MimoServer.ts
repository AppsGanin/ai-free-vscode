import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import { createLogger, errToString } from "../../logger";
import { ProviderError } from "../types";
import { cliEnv, mimoWorkDir, resolveMimoBinary } from "./MimoCli";

const slog = createLogger("mimo-server");

const PROVIDER_ID = "ai-free-vscode-mimo";
const STARTUP_TIMEOUT_MS = 60000;
/** Idle time after which the server is stopped rather than kept around. */
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
/** How long session cleanup may take before the process is killed anyway. */
const STOP_GRACE_MS = 3000;

const AGENT_NAME = "free-ai-vscode-chat";

/**
 * System prompt of the bridge agent. Its tools are fully disabled: all agentic
 * work (reading files, edits, tool calls) belongs to Copilot Chat, and mimocode
 * is only the transport to the model.
 */
const AGENT_PROMPT = [
  "You are a chat model accessed through an editor extension.",
  "You have NO tools available: never emit tool calls, never mention tools.",
  "Answer the user's request directly and completely in markdown.",
  "Follow any instructions and protocols given in the user message itself.",
].join(" ");

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export interface MimoServerHandle {
  url: string;
  /** Ready-made Basic auth header of the local server. */
  authHeader: string;
  /** Session working directory (neutral, outside the user's project). */
  directory: string;
}

/**
 * Owns the background `mimo serve` process — the headless mimocode server.
 *
 * Why a server and not `mimo run` per request: `run` prints the finished answer
 * in one piece (no streaming), while the server's `/event` SSE delivers deltas
 * token by token and supports cancellation. Credentials stay inside the CLI.
 */
export class MimoServer {
  private handle?: MimoServerHandle;
  private proc?: ChildProcess;
  private starting?: Promise<MimoServerHandle>;
  private idleTimer?: NodeJS.Timeout;
  private beforeStop?: () => Promise<void>;
  private disposed = false;

  /** Agent name we post messages under. */
  get agent(): string {
    return AGENT_NAME;
  }

  /** Starts the server (or reuses a running one) and returns its address. */
  async ensure(): Promise<MimoServerHandle> {
    if (this.disposed) {
      throw new ProviderError(PROVIDER_ID, "MiMo provider is disposed");
    }
    this.touch();

    if (this.handle && this.proc && !this.proc.killed) return this.handle;
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Extends the server lifetime; called on every request. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      slog.info("idle timeout — stopping server");
      this.stop();
    }, IDLE_SHUTDOWN_MS);
    // The timer must not keep the extension host alive.
    this.idleTimer.unref?.();
  }

  /**
   * Cleanup hook that gets a chance to run before the process is killed. The
   * client deletes its throwaway sessions in the background, and without this
   * pause the last DELETE never landed.
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
    if (!proc || proc.killed) return;

    slog.info("stopping server");
    // Wait for cleanup, but not for long: a hung server is worse than an
    // orphaned session.
    const cleanup = this.beforeStop?.() ?? Promise.resolve();
    void Promise.race([cleanup.catch(() => undefined), delay(STOP_GRACE_MS)])
      .catch(() => undefined)
      .finally(() => {
        if (!proc.killed) proc.kill();
      });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
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

    slog.info(`starting: ${bin} serve`);
    const proc = spawn(
      bin,
      ["serve", "--port", "0", "--hostname", "127.0.0.1", "--pure"],
      {
        cwd: directory,
        env: cliEnv({
          MIMOCODE_SERVER_USERNAME: username,
          MIMOCODE_SERVER_PASSWORD: password,
          MIMOCODE_CONFIG_CONTENT: JSON.stringify(buildConfig()),
        }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.proc = proc;

    proc.on("exit", (code, signal) => {
      slog.info(`server exited code=${code} signal=${signal}`);
      if (this.proc === proc) {
        this.proc = undefined;
        this.handle = undefined;
      }
    });
    proc.on("error", (err) => slog.error(`spawn error — ${errToString(err)}`));
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) slog.debug(`stderr: ${text.slice(0, 400)}`);
    });

    try {
      const handle: MimoServerHandle = {
        url: await waitForUrl(proc),
        authHeader: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        directory,
      };
      this.handle = handle;
      slog.info(`ready at ${handle.url}`);
      return handle;
    } catch (err) {
      proc.kill();
      this.proc = undefined;
      throw err;
    }
  }
}

/** Waits for the "listening on http://…" line on the server's stdout. */
function waitForUrl(proc: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const finish = (url?: string, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.off("exit", onExit);
      if (url) resolve(url);
      else
        reject(err ?? new ProviderError(PROVIDER_ID, "MiMo CLI server failed"));
    };

    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new ProviderError(
            PROVIDER_ID,
            "MiMo CLI server did not start in time",
          ),
        ),
      STARTUP_TIMEOUT_MS,
    );

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      buffer += text;
      slog.debug(`stdout: ${text.trim().slice(0, 200)}`);
      const match = /https?:\/\/[\w.-]+:\d+/.exec(buffer);
      if (match) finish(match[0]);
    };

    const onExit = (code: number | null) =>
      finish(
        undefined,
        new ProviderError(
          PROVIDER_ID,
          `MiMo CLI server exited before start (code=${code}). Run \`mimo\` in a terminal to finish setup.`,
        ),
      );

    proc.stdout?.on("data", onData);
    proc.on("exit", onExit);
  });
}

/**
 * Config passed through MIMOCODE_CONFIG_CONTENT: a single agent with no tools.
 * The user's own `mimocode.jsonc` is left alone, and credentials live elsewhere
 * (data-dir), so the CLI login keeps working.
 */
function buildConfig(): Record<string, unknown> {
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
