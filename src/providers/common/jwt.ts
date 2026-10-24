/** Renewed ahead of a request when the access token is this close to expiry. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Whether the JWT expires within the margin. A token without a readable
 * expiry (Z.ai's has none) never counts as expiring.
 */
export function expiresSoon(token: string, now = Date.now()): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp * 1000 - now < EXPIRY_MARGIN_MS;
  } catch {
    return false;
  }
}
