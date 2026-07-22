import * as os from "os";
import * as path from "path";
import type { BrowserContext, LaunchOptions, Page } from "playwright";
import { chromium } from "playwright";
import * as vscode from "vscode";

/** Every provider keeps its own browser profile under one root. */
export function profileDir(name: string): string {
  return path.join(os.homedir(), ".ai-free-vscode", name);
}

export function loginTimeoutMs(): number {
  return vscode.workspace
    .getConfiguration("freeAI")
    .get<number>("playwright.timeout", 120000);
}

export interface LaunchProfileOptions extends LaunchOptions {
  viewport?: { width: number; height: number };
  serviceWorkers?: "allow" | "block";
}

/**
 * Persistent context on `dataDir`. The system Chrome binary is tried first: it
 * is not flagged as automated, so Google OAuth and the anti-bots let it
 * through. Falls back to the bundled Chromium.
 */
export async function launchPersistentProfile(
  dataDir: string,
  options: LaunchProfileOptions,
): Promise<BrowserContext> {
  try {
    return await chromium.launchPersistentContext(dataDir, {
      ...options,
      channel: "chrome",
    });
  } catch {
    return await chromium.launchPersistentContext(dataDir, options);
  }
}

/** Persistent context for an interactive sign-in. */
export function launchLoginContext(dataDir: string): Promise<BrowserContext> {
  return launchPersistentProfile(dataDir, {
    headless: false,
    viewport: { width: 1280, height: 820 },
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
  });
}

/** Polls `read` until it returns a token or the timeout expires. */
export async function pollForToken(
  page: Page,
  timeoutMs: number,
  intervalMs: number,
  read: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const token = await read();
    if (token) return token;
    await page.waitForTimeout(intervalMs);
  }
  return undefined;
}

/** Reads the first non-empty value among the given localStorage keys. */
export function readLocalStorage(
  page: Page,
  keys: string[],
): Promise<string | null> {
  return page
    .evaluate((names: string[]) => {
      try {
        for (const name of names) {
          const value = localStorage.getItem(name);
          if (value) return value;
        }
      } catch {
        // storage blocked on this origin
      }
      return null;
    }, keys)
    .catch(() => null);
}

/** Strips `Bearer`, quotes and JSON wrappers off a stored token. */
export function normalizeToken(raw?: string | null): string | undefined {
  if (!raw) return undefined;

  let token = String(raw)
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    token = token.slice(1, -1).trim();
  }

  if (token.startsWith("{") || token.startsWith("[")) {
    try {
      const parsed = JSON.parse(token) as
        | string
        | Record<"token" | "accessToken" | "access_token" | "value", string>;
      token =
        typeof parsed === "string"
          ? parsed
          : (parsed.access_token ??
            parsed.accessToken ??
            parsed.token ??
            parsed.value ??
            token);
    } catch {
      // not JSON — keep as is
    }
  }

  return token || undefined;
}
