import fs from "node:fs";
import { AIProvider } from "../AIProvider.mjs";
import {
  clearProfileSession,
  loginAndSaveAuth,
  readSavedAuth,
} from "./auth.mjs";
import { AUTH_FILE } from "./config.mjs";
import {
  MODELS as DEEPSEEK_MODELS,
  runComplete as deepseekRunComplete,
} from "./provider.mjs";

import { formatBizError } from "./provider.mjs";

export class DeepSeekProvider extends AIProvider {
  getModels() {
    return DEEPSEEK_MODELS;
  }

  async login() {
    await clearProfileSession().catch(() => {});
    const result = await loginAndSaveAuth();
    return { auth: result };
  }

  async logout() {
    try {
      fs.rmSync(AUTH_FILE, { force: true });
    } catch {}
  }

  loadAuth() {
    try {
      return readSavedAuth();
    } catch (e) {
      console.warn(`DeepSeek: failed to read saved auth: ${e?.message || e}`);
      return null;
    }
  }

  async complete({
    modelId,
    prompt,
    auth,
    onText,
    onThinking,
    signal,
    threadKey,
    messagesCount,
  }) {
    return deepseekRunComplete({
      modelId,
      prompt,
      auth,
      onText,
      signal,
      threadKey,
      messagesCount,
    });
  }

  mapError(e) {
    if (e?.isBizError) {
      return formatBizError(e.bizCode, e.bizMsg, e.bizData);
    }
    if (e?.isToastError) {
      return `⚠️ DeepSeek: ${e.toastMsg}`;
    }
    return null;
  }
}
