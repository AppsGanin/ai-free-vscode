/**
 * The few settings the providers read from whatever hosts them. VS Code
 * answers from its configuration (src/vscode/hostSettings.ts); another host
 * (the DeepSeek Harness plugin) installs its own, and until one does the
 * defaults below apply.
 */
export interface HostSettings {
  /** How long a sign-in window waits for the user. */
  loginTimeoutMs(): number;
  /** Proxy for the browser windows, as typed by the user; "" goes direct. */
  proxy(): string;
  /** Hosts the browser proxy is bypassed for. */
  noProxy(): string[];
  /** Subscribes to changes of `proxy()` / `noProxy()`. */
  onProxyChange(listener: () => void): void;
}

const DEFAULTS: HostSettings = {
  loginTimeoutMs: () => 120000,
  proxy: () => "",
  noProxy: () => [],
  onProxyChange: () => undefined,
};

let current = DEFAULTS;

export function setHostSettings(settings: HostSettings): void {
  current = settings;
}

export function hostSettings(): HostSettings {
  return current;
}
