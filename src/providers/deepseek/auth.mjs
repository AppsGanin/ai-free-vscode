import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE, BASE_URL, BROWSER_PROFILE } from "./config.mjs";

// ─── Auth persistence ────────────────────────────────────────

export function normalizeToken(inputToken) {
  const token = String(inputToken || "").trim();
  if (!token) return "";
  try {
    const parsed = JSON.parse(token);
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed.value === "string") return parsed.value.trim();
  } catch {}
  return token;
}

export function cookieHeaderFromArray(parsed) {
  if (!Array.isArray(parsed))
    throw new Error("Cookie data must be a JSON array.");
  const usable = parsed.filter((cookie) => cookie?.name && "value" in cookie);
  if (!usable.some((cookie) => cookie.name === "ds_session_id"))
    throw new Error("Cookie file does not contain ds_session_id.");
  return usable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function readSavedAuth() {
  if (!fs.existsSync(AUTH_FILE)) return null;
  const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object") return null;
  const token = normalizeToken(parsed.userToken || parsed.token || "");
  const cookieHeader = cookieHeaderFromArray(parsed.cookies || []);
  return { token, cookieHeader };
}

export function writeSavedAuth({ cookies, userToken }) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      {
        version: 1,
        savedAt: new Date().toISOString(),
        baseUrl: BASE_URL,
        profileDir: BROWSER_PROFILE,
        userToken,
        cookies,
      },
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

export async function loginAndSaveAuth() {
  const { chromium } = await import("playwright");

  // Launch browser
  fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  const context = await launchPersistentContext(chromium, false);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  console.log("\n🔓 DeepSeek window will open. Sign in by any method.");
  console.log(
    "   The window will close automatically after a successful login.\n",
  );

  // Wait for successful API call with auth header
  await waitForAuthApiCall(context);

  // Capture cookies + token
  let cookies = [];
  let rawToken = null;
  try {
    cookies = await context.cookies(BASE_URL);
    rawToken = await page
      .evaluate(() => {
        try {
          return localStorage.getItem("userToken");
        } catch {
          return null;
        }
      })
      .catch(() => null);
  } catch {
    await context.close().catch(() => {});
    throw new Error("Failed to read state from the browser window.");
  }

  const token = normalizeToken(rawToken || "");
  const hasSessionCookie = cookies.some((c) => c.name === "ds_session_id");
  if (!token)
    throw new Error("No userToken in localStorage. Login not completed.");
  if (!hasSessionCookie)
    throw new Error("No ds_session_id in cookies. Login not completed.");

  writeSavedAuth({ cookies, userToken: rawToken });
  await context.close();

  console.log("✅ DeepSeek auth saved!\n");
  return { token, cookieHeader: cookieHeaderFromArray(cookies) };
}

export async function clearProfileSession() {
  const { chromium } = await import("playwright");
  const context = await launchPersistentContext(chromium, true);
  try {
    await context.clearCookies();
  } finally {
    await context.close().catch(() => {});
  }
}

// ─── Browser helpers ─────────────────────────────────────────

async function launchPersistentContext(chromium, headless) {
  const opts = {
    headless,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled"],
  };

  const tryLaunch = async () => {
    try {
      return await chromium.launchPersistentContext(BROWSER_PROFILE, {
        ...opts,
        channel: "chrome",
      });
    } catch (e) {
      try {
        return await chromium.launchPersistentContext(BROWSER_PROFILE, opts);
      } catch (e2) {
        throw new Error(`Chrome: ${e.message}. Chromium: ${e2.message}`);
      }
    }
  };

  try {
    return await tryLaunch();
  } catch (error) {
    const msg = String(error?.message || "");
    if (msg.includes("SingletonLock")) {
      for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try {
          fs.unlinkSync(path.join(BROWSER_PROFILE, f));
        } catch {}
      }
      try {
        return await tryLaunch();
      } catch (retryError) {
        throw new Error(`Failed to open browser: ${retryError.message}`);
      }
    }
    throw new Error(
      `Failed to open browser. Install Google Chrome or run "npx playwright install chromium". ${error.message}`,
    );
  }
}

function waitForAuthApiCall(
  context,
  { timeoutMs = 5 * 60 * 1000, settleMs = 800 } = {},
) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      context.off("response", handler);
      reject(
        new Error(
          `Login timeout ${Math.round(timeoutMs / 1000)}s. Sign in to the DeepSeek window.`,
        ),
      );
    }, timeoutMs);

    const handler = async (response) => {
      if (done) return;
      try {
        const url = response.url();
        if (!url.includes("/api/v0/")) return;
        if (response.status() !== 200) return;
        const reqHeaders = response.request().headers();
        const authHdr =
          reqHeaders["authorization"] || reqHeaders["Authorization"];
        if (!authHdr || !/^Bearer\s+\S{10,}/.test(authHdr)) return;
        let body = null;
        try {
          body = await response.json();
        } catch {
          return;
        }
        if (body && body.code !== undefined && body.code !== 0) return;

        done = true;
        clearTimeout(timer);
        context.off("response", handler);
        setTimeout(resolve, settleMs);
      } catch {}
    };

    context.on("response", handler);
  });
}
