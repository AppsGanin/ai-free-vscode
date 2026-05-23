class RateLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map();
  }

  isAllowed(identifier) {
    const now = Date.now();
    const requests = this.requests.get(identifier) || [];

    // Remove requests outside the current window
    const validRequests = requests.filter((time) => now - time < this.windowMs);

    if (validRequests.length >= this.maxRequests) {
      return false;
    }

    // Add current request
    validRequests.push(now);
    this.requests.set(identifier, validRequests);

    return true;
  }
}

// Global rate limiter instances
const apiRateLimiters = new Map();

export function getRateLimiter(provider, maxRequests = 15, windowMs = 60000) {
  const key = `${provider}_${maxRequests}_${windowMs}`;

  if (!apiRateLimiters.has(key)) {
    apiRateLimiters.set(key, new RateLimiter(maxRequests, windowMs));
  }

  return apiRateLimiters.get(key);
}

export function isApiCallAllowed(provider, identifier) {
  const limiter = getRateLimiter(provider);
  return limiter.isAllowed(identifier);
}
