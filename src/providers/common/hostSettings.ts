import * as os from "os";
import * as path from "path";

/**
 * The few settings the providers read from whatever hosts them. VS Code
 * answers from its configuration (src/vscode/hostSettings.ts); another host
 * (the DeepSeek Harness plugin) installs its own, and until one does the
 * defaults below apply.
 */
export interface HostSettings {
  /**
   * Folder holding the per-provider browser profiles. Each host keeps its
   * own: Chrome lets one process at a time open a profile.
   */
  profileRoot(): string;
  /** How long a sign-in window waits for the user. */
  loginTimeoutMs(): number;
  /** Proxy for the browser windows, as typed by the user; "" goes direct. */
  proxy(): string;
  /** Hosts the browser proxy is bypassed for. */
  noProxy(): string[];
  /** Subscribes to changes of `proxy()` / `noProxy()`. */
  onProxyChange(listener: () => void): void;
  /** How the browser bridge of `provider` shows its window. */
  browserMode(provider: "qwen" | "zai"): BrowserMode;
  /** A warning the user should see now (a captcha window opened, ...). */
  notify(message: string): void;
}

export type BrowserMode = "auto" | "headed" | "headless";

const DEFAULTS: HostSettings = {
  profileRoot: () => path.join(os.homedir(), ".ai-free-vscode"),
  loginTimeoutMs: () => 120000,
  proxy: () => "",
  noProxy: () => [],
  onProxyChange: () => undefined,
  browserMode: () => "auto",
  notify: () => undefined,
};

let current = DEFAULTS;

export function setHostSettings(settings: HostSettings): void {
  current = settings;
}

export function hostSettings(): HostSettings {
  return current;
}
