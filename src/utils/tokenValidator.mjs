import { BASE_URL, COMPLETION_PATH } from "../deepseek/config.mjs";
import { debug, error } from "./logger.mjs";

const VALIDATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const validationCache = new Map();

export async function isValidToken(cookieHeader, token, timeout = 5000) {
  const cacheKey = `${cookieHeader}:${token}`;
  const cached = validationCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < VALIDATION_CACHE_TTL) {
    debug("Token validation: Using cached result", { isValid: cached.isValid });
    return cached.isValid;
  }

  try {
    // Create a minimal request to validate the token
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${BASE_URL}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const isValid = response.status !== 401 && response.status !== 403;

    validationCache.set(cacheKey, {
      isValid,
      timestamp: Date.now(),
    });

    debug("Token validation completed", { isValid, status: response.status });

    return isValid;
  } catch (err) {
    error("Token validation failed", { error: err.message });

    // Still cache the failure to avoid repeated attempts
    validationCache.set(cacheKey, {
      isValid: false,
      timestamp: Date.now(),
    });

    return false;
  }
}

export function clearTokenValidationCache() {
  validationCache.clear();
}
