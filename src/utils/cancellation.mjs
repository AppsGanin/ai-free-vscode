/**
 * Utilities for bridging VS Code cancellation tokens with the Web
 * AbortController / AbortSignal API used by fetch-based providers.
 */

/**
 * Creates an AbortController that is cancelled when the VS Code
 * `CancellationToken` fires.
 *
 * Returns an object with:
 *  - `signal`  — pass to fetch / provider.complete()
 *  - `dispose` — call in a finally block to clean up the event listener
 *
 * @param {import("vscode").CancellationToken} token
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
export function tokenToAbort(token) {
  const controller = new AbortController();

  if (token?.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, cancel: () => {}, dispose: () => {} };
  }

  const sub = token.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    cancel: () => controller.abort(),
    dispose: () => sub.dispose(),
  };
}

/**
 * Returns true when the error represents an aborted / cancelled request.
 * Covers both the Web AbortError and Node's ABORT_ERR code.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    /abort/i.test(String(error?.message ?? ""))
  );
}
