import { errToString } from "../../logger";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";

/** Maps auth / rate-limit statuses onto typed provider errors. */
export function throwForStatus(
  providerId: string,
  response: Response,
  authStatuses: readonly number[] = [401, 403],
): void {
  if (authStatuses.includes(response.status)) {
    throw new AuthExpiredError(providerId);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new RateLimitError(
      providerId,
      retryAfter > 0 ? retryAfter * 1000 : undefined,
    );
  }
}

/** Same mapping for backends that report a status without a Response. */
export function toProviderError(
  providerId: string,
  status: number,
  text: string,
): Error {
  if (status === 401 || status === 403) {
    return new AuthExpiredError(providerId);
  }
  if (status === 429) {
    return new RateLimitError(providerId);
  }
  return new ProviderError(
    providerId,
    `HTTP ${status}: ${text.slice(0, 200)}`,
    status,
  );
}

/** True when the failure is a cancelled request rather than a real error. */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return (
    !!signal?.aborted ||
    err instanceof DOMException ||
    (err instanceof Error && /abort/i.test(err.message))
  );
}

/**
 * A dropped connection rather than a rejected request — worth retrying.
 *
 * Node's fetch collapses every transport problem into "fetch failed" and keeps
 * the real code in `cause`, which errToString unwraps. TLS resets to these
 * free web backends are common enough that a single one must not surface as a
 * chat error.
 */
export function isNetworkFailure(err: unknown): boolean {
  return (
    err instanceof Error &&
    /fetch failed|terminated|socket hang up|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR/i.test(
      errToString(err),
    )
  );
}
