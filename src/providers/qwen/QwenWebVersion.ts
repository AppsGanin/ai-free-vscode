import { errToString, log } from "../../logger";

/**
 * The `version` header of the chat.qwen.ai web client. The API answers a
 * stale one with `Bad_Request: Internal error...` on every completion, so it
 * is read from the live home page (`…/qwen-chat-fe/<version>/js/main.js`)
 * instead of being pinned here.
 */

const HOME_URL = "https://chat.qwen.ai/";
/** Last version seen by hand; used until the home page has been read. */
const FALLBACK_WEB_VERSION = "0.3.22";
const MAX_AGE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const ASSET_VERSION = /qwen-chat-fe\/(\d+(?:\.\d+)+)\//;

let current = FALLBACK_WEB_VERSION;
let checkedAt = 0;
let inFlight: Promise<string> | undefined;

/** The version to send now: the last one read, or the built-in fallback. */
export function webVersion(): string {
  return current;
}

/** Pulls the client version out of the home page HTML. */
export function parseWebVersion(html: string): string | undefined {
  return ASSET_VERSION.exec(html)?.[1];
}

/**
 * Re-reads the version when the cached one is older than an hour, or always
 * with `force` (after the API refused a request). Never throws: on any failure
 * the previous version stays.
 */
export function refreshWebVersion(force = false): Promise<string> {
  if (!force && Date.now() - checkedAt < MAX_AGE_MS) {
    return Promise.resolve(current);
  }
  inFlight ??= readHomePage().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function readHomePage(): Promise<string> {
  try {
    const response = await fetch(HOME_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const found = parseWebVersion(await response.text());
    if (!found) {
      log(`[qwen-api] web version not found on the home page (HTTP ${response.status}), keeping ${current}`);
    } else if (found !== current) {
      log(`[qwen-api] web version ${current} → ${found}`);
      current = found;
    }
  } catch (err) {
    log(`[qwen-api] could not read the web version, keeping ${current} — ${errToString(err)}`);
  }
  // A failure is retried after the same interval: the home page being down
  // must not cost every request a 5-second wait.
  checkedAt = Date.now();
  return current;
}

/** Test hook: forget what was read. */
export function resetWebVersion(): void {
  current = FALLBACK_WEB_VERSION;
  checkedAt = 0;
  inFlight = undefined;
}
