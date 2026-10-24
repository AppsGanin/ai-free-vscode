import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setDebugSwitch, setOutputChannel } from "../../src/logger";
import { type BrowserMode, setHostSettings } from "../../src/providers/common/hostSettings";
import type { SecretStore } from "../../src/providers/types";

/**
 * Everything this host keeps lives under `~/.ai-free-vscode/dsh`: its own
 * browser profiles (Chrome lets one process open a profile, and the VS Code
 * extension may hold the shared ones), the sign-ins and the log.
 */
export const DSH_HOME = path.join(os.homedir(), ".ai-free-vscode", "dsh");

export interface HostOptions {
  debug: boolean;
  loginTimeoutMs: number;
  proxy: string;
  browserMode: BrowserMode;
}

/**
 * Wires the provider core to DeepSeek Harness. The log goes to a file: stdout
 * belongs to the ACP protocol, and the harness console is not ours to fill.
 */
export function installHost(options: HostOptions): void {
  mkdirSync(DSH_HOME, { recursive: true });
  const logFile = path.join(DSH_HOME, "free-ai.log");
  setOutputChannel({
    appendLine: (line) => {
      try {
        appendFileSync(logFile, `${line}\n`);
      } catch {
        // A log that cannot be written must not fail the request.
      }
    },
  });
  setDebugSwitch(() => options.debug);
  setHostSettings({
    profileRoot: () => DSH_HOME,
    loginTimeoutMs: () => options.loginTimeoutMs,
    proxy: () => options.proxy,
    noProxy: () => [],
    onProxyChange: () => undefined,
    browserMode: () => options.browserMode,
    // A captcha window just opened: the harness has no toast to raise, so
    // stderr is where someone at the terminal will see it.
    notify: (message) => console.error(`[free-ai] ${message}`),
  });
}

/**
 * Sign-ins in one JSON file readable by the user only. The providers keep a
 * session cookie or Bearer per account here, as SecretStorage does in VS Code.
 */
export class FileSecretStore implements SecretStore {
  private cache: Record<string, string> | undefined;

  constructor(private readonly file = path.join(DSH_HOME, "sessions.json")) {}

  async get(key: string): Promise<string | undefined> {
    return this.read()[key];
  }

  async store(key: string, value: string): Promise<void> {
    this.write({ ...this.read(), [key]: value });
  }

  async delete(key: string): Promise<void> {
    const { [key]: _gone, ...rest } = this.read();
    this.write(rest);
  }

  private read(): Record<string, string> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private write(values: Record<string, string>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    // Written aside and renamed, so a crash never leaves half a file.
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, JSON.stringify(values, null, 2), { mode: 0o600 });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
    this.cache = values;
  }
}
