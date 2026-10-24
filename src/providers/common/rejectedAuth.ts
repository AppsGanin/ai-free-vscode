import type * as vscode from "vscode";

/**
 * Deletes a stored sign-in the server has just refused, so the next request
 * reports "signed out" instead of sending the same dead credential again.
 *
 * Only while the secret still holds that credential: a sign-in that finished
 * in the meantime (another window, the Sign In command) must survive. The
 * browser profile is left alone, which keeps the next sign-in quick.
 *
 * @returns whether the secret was removed.
 */
export async function forgetRejected(
  secrets: vscode.SecretStorage,
  key: string,
  isRejected: (stored: string) => boolean,
): Promise<boolean> {
  const stored = await secrets.get(key);
  if (!stored || !isRejected(stored)) return false;
  await secrets.delete(key);
  return true;
}

/** The `token` field of a JSON-encoded sign-in, if any. */
export function storedToken(stored: string): string | undefined {
  try {
    const token = (JSON.parse(stored) as { token?: unknown }).token;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}
