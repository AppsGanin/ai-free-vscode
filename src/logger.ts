import { AsyncLocalStorage } from "async_hooks";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** Where lines go: VS Code's output channel, or the host's console. */
export interface LogSink {
  appendLine(line: string): void;
}

let channel: LogSink | undefined;

export function setOutputChannel(output: LogSink): void {
  channel = output;
}

/**
 * Whether DEBUG lines are wanted. The host installs its own switch (VS Code
 * reads `freeAI.debug`); it is asked on every line, so a toggle needs no reload.
 */
let debugSwitch: () => boolean = () => false;

export function setDebugSwitch(enabled: () => boolean): void {
  debugSwitch = enabled;
}

/** Lines kept for the debug report: enough for a few failed requests. */
const RECENT_LINES = 1500;
const recent: string[] = [];

/**
 * The chat request a line belongs to. Copilot fires several requests at once
 * (the answer plus its housekeeping), and without an id their lines
 * interleave into something nobody can follow in an issue.
 */
const requestContext = new AsyncLocalStorage<{ id: string }>();

/**
 * Runs `fn` with every log line inside it — the provider's, the router's, the
 * browser bridge's — tagged `[#id]`.
 */
export function withRequestId<T>(id: string, fn: () => T): T {
  return requestContext.run({ id }, fn);
}

/** Short id for one request: `a1b2`. */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** DEBUG is printed only while the debug switch is on; other levels always are. */
function write(level: LogLevel, message: string): void {
  if (level === "DEBUG" && !isDebugEnabled()) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const request = requestContext.getStore()?.id;
  const line = `[${ts}] [${level}]${request ? ` [#${request}]` : ""} ${redact(message)}`;
  channel?.appendLine(line);
  recent.push(line);
  if (recent.length > RECENT_LINES) recent.splice(0, recent.length - RECENT_LINES);
}

/** The last lines written, for the debug report. Already redacted. */
export function recentLog(): string[] {
  return [...recent];
}

/** Names whose value is a credential, with an optional `xxx_` prefix. */
const SECRET_KEYS =
  "(?:token|session|sessionid|sid|auth|secret|password|passwd|api_?key|key|ticket|credential)";

/**
 * Removes what must never end up in an issue: tokens, keys, cookies, proxy
 * credentials, e-mail addresses. Applied to every line, so a careless log call
 * cannot leak a secret into a pasted report.
 */
export function redact(text: string): string {
  return (
    text
      // Bearer and JWT tokens (every web provider's session is one).
      .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer ***")
      .replace(/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, "eyJ***")
      // API keys.
      .replace(/\bsk-[\w-]{8,}/g, "sk-***")
      // Credentials in a URL: proxy://user:pass@host.
      .replace(/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***:***@")
      // Cookie and Authorization headers.
      .replace(/(\bcookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, "$1***")
      .replace(/(\bauthorization["']?\s*[:=]\s*["']?)(?!Bearer \*)[^"',\s]+/gi, "$1***")
      // Secret key=value (cookies, query strings) and "key": "value" (JSON).
      // Whole key names only: `sessionKind=new` or `inside=1` stay readable.
      .replace(new RegExp(`\\b((?:[\\w-]*[_-])?${SECRET_KEYS})=[^;&\\s"']+`, "gi"), "$1=***")
      .replace(new RegExp(`("(?:[\\w-]*[_-])?${SECRET_KEYS}"\\s*:\\s*)"[^"]*"`, "gi"), '$1"***"')
      // E-mail addresses (account names show up in auth responses); a
      // `package@1.2.3` has no letters in its last part and stays.
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g, "***@***")
  );
}

/**
 * Exported so callers can skip work that only feeds a DEBUG line — the browser
 * bridge pays a page round-trip to unwrap console arguments.
 */
export function isDebugEnabled(): boolean {
  try {
    return debugSwitch();
  } catch {
    return false;
  }
}

/** INFO log with a caller-supplied prefix. */
export function log(message: string): void {
  write("INFO", message);
}

export interface ScopedLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Logger with a fixed `[scope]` prefix:
 * `createLogger("qwen-auth").info("ok")` → `[12:34:56.789] [INFO] [qwen-auth] ok`
 */
export function createLogger(scope: string): ScopedLogger {
  const prefix = `[${scope}]`;
  return {
    debug: (m) => write("DEBUG", `${prefix} ${m}`),
    info: (m) => write("INFO", `${prefix} ${m}`),
    warn: (m) => write("WARN", `${prefix} ${m}`),
    error: (m) => write("ERROR", `${prefix} ${m}`),
  };
}

/**
 * Node's fetch reports a bare "fetch failed" and hides the real reason in
 * `cause`, so the chain is unwrapped — otherwise the log says nothing at all.
 */
export function errToString(err: unknown): string {
  if (!(err instanceof Error)) {
    return typeof err === "string" ? err : String(err);
  }

  const base = err.message || err.name;
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) return base;

  const detail =
    cause instanceof Error
      ? [(cause as NodeJS.ErrnoException).code, cause.message]
          .filter(Boolean)
          .join(": ")
      : String(cause);
  return detail ? `${base} (${detail})` : base;
}

/**
 * Everything worth knowing about a failure for a DEBUG line: its class, the
 * provider and HTTP status our errors carry, and where it was thrown.
 */
export function errDetails(err: unknown): string {
  if (!(err instanceof Error)) return errToString(err);
  const extra = err as Error & { providerId?: string; statusCode?: number; retryAfterMs?: number };
  const tags = [
    err.name,
    extra.providerId && `provider=${extra.providerId}`,
    extra.statusCode !== undefined && `status=${extra.statusCode}`,
    extra.retryAfterMs !== undefined && `retryAfter=${extra.retryAfterMs}ms`,
  ].filter(Boolean);
  const stack = (err.stack ?? "")
    .split("\n")
    .slice(1, 6)
    .map((frame) => frame.trim())
    .join(" ← ");
  return `${tags.join(" ")}: ${errToString(err)}${stack ? ` | at ${stack}` : ""}`;
}
