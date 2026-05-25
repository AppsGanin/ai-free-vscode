import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/** DeepSeek API base URL */
export const BASE_URL = "https://chat.deepseek.com";

/** Completion API path */
export const COMPLETION_PATH = "/api/v0/chat/completion";

/** Application version */
export const APP_VERSION = "1.0.2";

/** Path to the auth persistence file */
export const AUTH_FILE = path.join(os.homedir(), ".deepseek-copilot-auth.json");

/** Playwright browser profile directory */
export const BROWSER_PROFILE = path.join(
  os.homedir(),
  ".deepseek-copilot-browser",
);

/** SHA3 WASM module for the PoW solver */
export const DEEPSEEK_SHA3_WASM =
  "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

/** Generates a request_id for the API */
export function generateRequestId() {
  return randomUUID().replace(/-/g, "");
}
