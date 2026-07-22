import type { BrowserContext } from "playwright";
import { launchPersistentProfile, profileDir } from "../common/browserAuth";

/**
 * Shared profile directory. It holds the cookies of the live Qwen session, used
 * both by sign-in and by the browser fallback when the Aliyun WAF blocks us.
 */
export const BROWSER_DATA_DIR = profileDir("browser-profile");

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
];

// Far off-screen: the browser stays headed (real rendering and fingerprint, so
// the anti-bot keeps quiet) without getting in the user's way.
const OFFSCREEN_ARGS = ["--window-position=-32000,-32000"];

/**
 * Launches a persistent context on the shared profile. The system Chrome comes
 * first — its TLS/JA3 fingerprint passes the Aliyun WAF and Google OAuth —
 * with the bundled Chromium as fallback.
 */
export async function launchQwenContext(options: {
  headless: boolean;
  /**
   * "block" forbids service workers. chat.qwen.ai registers one that intercepts
   * and hangs the API fetch inside the background bridge.
   */
  serviceWorkers?: "allow" | "block";
  /** Move the window off-screen (bridge only; sign-in stays visible). */
  offscreen?: boolean;
}): Promise<BrowserContext> {
  return launchPersistentProfile(BROWSER_DATA_DIR, {
    headless: options.headless,
    viewport: { width: 1280, height: 800 },
    args: options.offscreen ? [...LAUNCH_ARGS, ...OFFSCREEN_ARGS] : LAUNCH_ARGS,
    serviceWorkers: options.serviceWorkers ?? "allow",
  });
}
