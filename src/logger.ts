import * as vscode from "vscode";

let _channel: vscode.OutputChannel | undefined;

export function setOutputChannel(channel: vscode.OutputChannel): void {
  _channel = channel;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/**
 * DEBUG-логи печатаются только при включённой настройке `freeAI.debug`.
 * Остальные уровни печатаются всегда. Конфиг читаем лениво и не кэшируем —
 * вызовов немного, зато тумблер срабатывает без перезапуска.
 */
function isDebugEnabled(): boolean {
  try {
    return vscode.workspace
      .getConfiguration("freeAI")
      .get<boolean>("debug", false);
  } catch {
    return false;
  }
}

function write(level: LogLevel, message: string): void {
  if (level === "DEBUG" && !isDebugEnabled()) {
    return;
  }
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  _channel?.appendLine(`[${ts}] [${level}] ${message}`);
}

/** INFO-лог (печатается всегда). Обратно совместим со старым `log(...)`. */
export function log(message: string): void {
  write("INFO", message);
}

export function logDebug(message: string): void {
  write("DEBUG", message);
}

export function logWarn(message: string): void {
  write("WARN", message);
}

export function logError(message: string): void {
  write("ERROR", message);
}

export interface ScopedLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Логгер с единым префиксом `[scope]` — общий формат для всех провайдеров.
 * Пример: `createLogger("qwen-auth").info("login success")`
 * → `[12:34:56.789] [INFO] [qwen-auth] login success`.
 */
export function createLogger(scope: string): ScopedLogger {
  const prefix = `[${scope}]`;
  return {
    debug: (m: string) => write("DEBUG", `${prefix} ${m}`),
    info: (m: string) => write("INFO", `${prefix} ${m}`),
    warn: (m: string) => write("WARN", `${prefix} ${m}`),
    error: (m: string) => write("ERROR", `${prefix} ${m}`),
  };
}

/** Безопасно приводит ошибку к строке для лога. */
export function errToString(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return typeof err === "string" ? err : String(err);
}
