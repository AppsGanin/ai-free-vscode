let debugMode = false;

export function setDebugMode(enabled) {
  debugMode = enabled;
}

export function log(level, message, meta = {}) {
  if (!debugMode && level === "debug") {
    return;
  }

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...meta,
  };

  // Output to console
  const formattedMessage = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  if (Object.keys(meta).length > 0) {
    console.log(formattedMessage, meta);
  } else {
    console.log(formattedMessage);
  }
}

export function debug(message, meta = {}) {
  log("debug", message, meta);
}

export function info(message, meta = {}) {
  log("info", message, meta);
}

export function warn(message, meta = {}) {
  log("warn", message, meta);
}

export function error(message, meta = {}) {
  log("error", message, meta);
}
