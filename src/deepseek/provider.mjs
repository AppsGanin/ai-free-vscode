import { debug, error, info } from "../utils/logger.mjs";
import { isApiCallAllowed } from "../utils/rateLimiter.mjs";
import { isValidToken } from "../utils/tokenValidator.mjs";
import { DeepSeekClient } from "./client.mjs";

export const MODELS = [
  {
    id: "deepseek-default",
    name: "DeepSeek V4 (default)",
    family: "deepseek",
    version: "1.0.0",
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "DeepSeek via browser session (no API key)",
  },
  {
    id: "deepseek-expert",
    name: "DeepSeek V4 (expert)",
    family: "deepseek",
    version: "1.0.0",
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "DeepSeek via browser session (no API key)",
  },
];

export const MODEL_PARAMS = {
  "deepseek-default": { modelType: "default", thinkingEnabled: false },
  "deepseek-expert": { modelType: "expert", thinkingEnabled: true },
};

/** threadKey → sessionId cache so the same VS Code thread reuses one DeepSeek session */
const sessionIdCache = new Map();

/**
 * Runs a DeepSeek completion and streams text via onText().
 * Throws an error with `isNotSignedIn=true` if auth is missing.
 *
 * @param {{
 *   modelId: string,
 *   prompt: string,
 *   auth: { cookieHeader: string, token: string } | null,
 *   onText: (text: string) => Promise<void>,
 *   signal: AbortSignal,
 *   threadKey?: string,
 * }} opts
 */
export async function runComplete({
  modelId,
  prompt,
  auth,
  onText,
  signal,
  threadKey,
  messagesCount,
}) {
  // Validate authentication
  if (!auth?.cookieHeader && !auth?.token) {
    const err = new Error(
      '⚠️ DeepSeek is not signed in. Run the "DeepSeek: Sign In" command.',
    );
    err.isNotSignedIn = true;
    error("Authentication failed", { modelId });
    throw err;
  }

  // Check token validity
  const isValid = await isValidToken(auth.cookieHeader, auth.token);
  if (!isValid) {
    const err = new Error(
      "⚠️ DeepSeek token is invalid or expired. Please sign in again.",
    );
    err.isNotSignedIn = true;
    error("Token validation failed", { modelId });
    throw err;
  }

  // Check rate limit
  const userId = auth.token.substring(0, 8); // Use a portion of the token as identifier
  if (!isApiCallAllowed("deepseek", userId)) {
    const err = new Error("Too many requests. Please slow down.");
    error("Rate limit exceeded", { userId });
    throw err;
  }

  // Log the request
  info("Starting DeepSeek completion", {
    modelId,
    promptLength: prompt.length,
  });

  const client = new DeepSeekClient({
    cookieHeader: auth.cookieHeader,
    token: auth.token,
    debug: true,
  });

  const params = MODEL_PARAMS[modelId] ?? MODEL_PARAMS["deepseek-default"];
  const cacheKey = threadKey ?? modelId;

  // First message of a new VS Code thread — always start a fresh DeepSeek session
  if (messagesCount === 1) {
    sessionIdCache.delete(cacheKey);
  }

  /**
   * Attempt completion with the given sessionId.
   * Returns true on success, throws non-retriable errors.
   * Returns false when the session appears stale (caller should retry with new session).
   */
  async function attempt(sessionId) {
    try {
      await client.complete({
        sessionId,
        prompt,
        modelType: params.modelType,
        thinkingEnabled: params.thinkingEnabled,
        searchEnabled: false,
        onText,
        signal,
      });
      info("DeepSeek completion completed successfully", {
        modelId,
        sessionId,
      });
      return true;
    } catch (completionErr) {
      // Treat session-not-found or auth errors as stale session
      if (
        completionErr.isAuthError ||
        /session|not found|invalid.*session/i.test(completionErr.message)
      ) {
        debug(`Session ${sessionId} stale: ${completionErr.message}`);
        return false;
      }
      error("DeepSeek completion failed", {
        modelId,
        sessionId,
        error: completionErr.message,
        stack: completionErr.stack,
      });
      throw completionErr;
    }
  }

  // Try cached session first
  const cachedSessionId = sessionIdCache.get(cacheKey);
  if (cachedSessionId) {
    debug(`Reusing DeepSeek session ${cachedSessionId}`);
    const ok = await attempt(cachedSessionId);
    if (ok) return;
    // Session was stale — fall through to create a new one
    sessionIdCache.delete(cacheKey);
  }

  // Create a new session and cache it
  debug("Creating DeepSeek session...");
  let sessionId;
  try {
    sessionId = await client.createSession({ signal });
    debug(`Session created: ${sessionId}`);
  } catch (sessionErr) {
    error("Failed to create session", { error: sessionErr.message });
    throw sessionErr;
  }
  sessionIdCache.set(cacheKey, sessionId);

  await attempt(sessionId);
}

export function formatBizError(code, msg, data) {
  switch (code) {
    case 5: {
      if (data?.mute_until) {
        const until = new Date(data.mute_until * 1000).toLocaleString("ru-RU");
        return `🚫 DeepSeek account temporarily blocked until ${until}. Try later or switch accounts.`;
      }
      return "🚫 DeepSeek account temporarily blocked. Try later or switch accounts.";
    }
    case 2:
      return "⚠️ DeepSeek: too many requests. Please wait a moment and retry.";
    case 3:
      return "⚠️ DeepSeek: content rejected by the safety system. Modify your request and retry.";
    default:
      return `⚠️ DeepSeek returned an error (code ${code}): ${msg ?? "unknown error"}.`;
  }
}
