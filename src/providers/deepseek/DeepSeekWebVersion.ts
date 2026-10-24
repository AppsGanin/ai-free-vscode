import { errToString, log } from "../../logger";

/**
 * The `x-client-version` of the chat.deepseek.com web client, read from its
 * live bundle (`appVersion:"…"` in `static/main.<hash>.js`) so it follows web
 * releases instead of being pinned here.
 *
 * The home page sits behind the AWS WAF: without the session cookies it
 * answers an empty 202, so the lookup goes with them.
 */

const HOME_URL = "https://chat.deepseek.com/";
const STATIC_ORIGIN = "https://fe-static.deepseek.com/chat/";
/** Last version seen by hand; used until the bundle has been read. */
const FALLBACK_APP_VERSION = "2.7.0";
// The bundle is ~1.6 MB: read it a few times a day, not per request.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const MAIN_BUNDLE = /static\/main\.[0-9a-f]+\.js/;
const APP_VERSION = /appVersion:"(\d+(?:\.\d+)+)"/;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

let current = FALLBACK_APP_VERSION;
let checkedAt = 0;
let inFlight: Promise<string> | undefined;

/** The version to send now: the last one read, or the built-in fallback. */
export function appVersion(): string {
  return current;
}

/** `static/main.<hash>.js` as linked from the home page. */
export function parseMainBundle(html: string): string | undefined {
  return MAIN_BUNDLE.exec(html)?.[0];
}

export function parseAppVersion(bundle: string): string | undefined {
  return APP_VERSION.exec(bundle)?.[1];
}

/**
 * Re-reads the version when the cached one is older than six hours. Never
 * throws: on any failure the previous version stays.
 */
export function refreshAppVersion(cookieHeader: string): Promise<string> {
  if (Date.now() - checkedAt < MAX_AGE_MS) return Promise.resolve(current);
  inFlight ??= readBundle(cookieHeader).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function readBundle(cookieHeader: string): Promise<string> {
  try {
    const home = await fetch(HOME_URL, {
      headers: { "User-Agent": USER_AGENT, Cookie: cookieHeader },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const bundle = parseMainBundle(await home.text());
    if (!bundle) {
      log(`[deepseek-api] main bundle not found on the home page (HTTP ${home.status}), keeping ${current}`);
    } else {
      const js = await fetch(STATIC_ORIGIN + bundle, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const found = parseAppVersion(await js.text());
      if (!found) {
        log(`[deepseek-api] appVersion not found in ${bundle}, keeping ${current}`);
      } else if (found !== current) {
        log(`[deepseek-api] web version ${current} → ${found}`);
        current = found;
      }
    }
  } catch (err) {
    log(`[deepseek-api] could not read the web version, keeping ${current} — ${errToString(err)}`);
  }
  // A failure waits out the same interval: a slow home page must not delay
  // every request.
  checkedAt = Date.now();
  return current;
}

/** Test hook: forget what was read. */
export function resetAppVersion(): void {
  current = FALLBACK_APP_VERSION;
  checkedAt = 0;
  inFlight = undefined;
}
