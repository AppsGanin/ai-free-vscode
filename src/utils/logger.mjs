/**
 * Logger with VS Code Output Channel support.
 * Supports level-based filtering, per-provider tags, and structured output.
 */

/** @type {import('vscode').OutputChannel | undefined} */
let _channel;
5;

let _debugMode = false;
let _levelFilter = "debug"; // show all by default

const LEVELS = ["debug", "info", "warn", "error"];

function levelIndex(level) {
  const idx = LEVELS.indexOf(level);
  return idx === -1 ? 0 : idx;
}

function ts() {
  return new Date().toISOString().slice(11, 23);
}

/**
 * Must be called once from extension.mjs activate() to attach the VS Code output channel.
 * @param {import('vscode').OutputChannel} channel
 */
export function initChannel(channel) {
  _channel = channel;
}

function getChannel() {
  return _channel;
}

function write(level, message, meta) {
  const minIdx = levelIndex(_levelFilter);
  if (levelIndex(level) < minIdx) return;

  const metaStr =
    meta && Object.keys(meta).length > 0
      ? " " + JSON.stringify(meta, null, 0)
      : "";

  const line = `[${ts()}] [${level.toUpperCase()}] ${message}${metaStr}`;

  // VS Code output channel
  try {
    getChannel()?.appendLine(line);
  } catch {
    // channel may be disposed
  }

  // Console fallback (shows up in Developer Tools / Debug Console)
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else if (_debugMode) {
    console.log(line);
  }
}

export function setDebugMode(enabled) {
  _debugMode = !!enabled;
}

export function isDebugMode() {
  return _debugMode;
}

/**
 * Set minimum log level to display: 'debug' | 'info' | 'warn' | 'error'
 */
export function setLevelFilter(level) {
  if (LEVELS.includes(level)) _levelFilter = level;
}

export function log(level, message, meta = {}) {
  write(level, message, meta);
}

export function debug(message, meta = {}) {
  write("debug", message, meta);
}

export function info(message, meta = {}) {
  write("info", message, meta);
}

export function warn(message, meta = {}) {
  write("warn", message, meta);
}

export function error(message, meta = {}) {
  write("error", message, meta);
}

/** Reveal the Output Channel in the VS Code UI */
export function show() {
  try {
    getChannel()?.show();
  } catch {
    // channel may be disposed
  }
}

/** Dispose the Output Channel (call on extension deactivation) */
export function dispose() {
  try {
    _channel?.dispose();
  } catch {
    // ignore
  } finally {
    _channel = undefined;
  }
}
