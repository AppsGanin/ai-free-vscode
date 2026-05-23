import os from "node:os";
import path from "node:path";

/** Qwen API base URL */
export const BASE_URL = "https://chat.qwen.ai";

/** Path to create a new chat */
export const CREATE_CHAT_PATH = "/api/v2/chats/new";

/** Chat completions API path */
export const CHAT_API_PATH = "/api/v2/chat/completions";

/** Path to the auth persistence file */
export const AUTH_FILE = path.join(os.homedir(), ".qwen-copilot-auth.json");

/** Playwright browser profile directory */
export const BROWSER_PROFILE = path.join(os.homedir(), ".qwen-copilot-browser");

/** Browser User-Agent used for API requests */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
