/**
 * Qwen authentication — counterpart to deepseek/auth.mjs.
 * Opens a Playwright browser and polls localStorage.getItem('token')
 * on chat.qwen.ai once per second until a Bearer token appears.
 */

import fs from "node:fs";
import path from "node:path";

import { AUTH_FILE, BASE_URL, BROWSER_PROFILE } from "./config.mjs";
export { AUTH_FILE, BASE_URL, BROWSER_PROFILE } from "./config.mjs";

// ─── Persistence ─────────────────────────────────────────────

export function readSavedAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    if (!parsed?.token) return null;
    return { token: String(parsed.token).trim() };
  } catch {
    return null;
  }
}

export function writeSavedAuth({ token }) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      { version: 1, savedAt: new Date().toISOString(), token },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {}
}

// ─── Browser login (Playwright) ──────────────────────────────

/** Launches real Chrome or Chromium with automation detection disabled. */
async function launchContext(chromium) {
  // Remove Chromium's SingletonLock to avoid "browser has been closed" errors
  // when the previous session was not cleanly terminated.
  const lockFile = path.join(BROWSER_PROFILE, "SingletonLock");
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // ignore — lock may not exist
  }

  const opts = {
    headless: false,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  // Try system Chrome first — not blocked by OAuth providers
  try {
    return await chromium.launchPersistentContext(BROWSER_PROFILE, {
      ...opts,
      channel: "chrome",
    });
  } catch {
    // Fallback to bundled Playwright Chromium
    return await chromium.launchPersistentContext(BROWSER_PROFILE, opts);
  }
}

export async function loginAndSaveAuth() {
  const { chromium } = await import("playwright");

  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const context = await launchContext(chromium);

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  console.log("\n🔓 Qwen window will open. Sign in by any method.");
  console.log(
    "   The window will close automatically after a successful login.\n",
  );

  let token;
  try {
    token = await pollToken(context);
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }

  writeSavedAuth({ token });
  await context.close();

  console.log("✅ Qwen auth saved!\n");
  return { token };
}

/**
 * Polls localStorage.getItem('token') on all context tabs
 * once per second until a token appears or the timeout expires (5 minutes).
 * Works across navigations and new tabs.
 */
function pollToken(context, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    async function check() {
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `Login timeout ${Math.round(timeoutMs / 1000)}s. Sign in to the Qwen window.`,
          ),
        );
        return;
      }

      for (const p of context.pages()) {
        try {
          if (!p.url().includes("qwen.ai")) continue;
          const token = await p.evaluate(() => localStorage.getItem("token"));
          if (token && token.length > 20) {
            resolve(token);
            return;
          }
        } catch {
          // page may have closed or not yet loaded
        }
      }

      setTimeout(check, 1000);
    }

    setTimeout(check, 1000);
  });
}

export async function clearProfileSession() {
  if (!fs.existsSync(BROWSER_PROFILE)) return;
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    headless: true,
  });
  try {
    await context.clearCookies();
  } finally {
    await context.close().catch(() => {});
  }
}
