import fs from "node:fs";
import { AIProvider } from "../AIProvider.mjs";
import {
  clearProfileSession as clearQwenProfileSession,
  loginAndSaveAuth as loginAndSaveQwenAuth,
  readSavedAuth as readSavedQwenAuth,
} from "./auth.mjs";
import { AUTH_FILE as QWEN_AUTH_FILE } from "./config.mjs";
import {
  MODELS as QWEN_MODELS,
  runComplete as qwenRunComplete,
} from "./provider.mjs";

export class QwenProvider extends AIProvider {
  getModels() {
    return QWEN_MODELS;
  }

  async login() {
    await clearQwenProfileSession().catch(() => {});
    const result = await loginAndSaveQwenAuth();
    return { auth: result };
  }

  async logout() {
    try {
      fs.rmSync(QWEN_AUTH_FILE, { force: true });
    } catch {}
  }

  loadAuth() {
    try {
      return readSavedQwenAuth();
    } catch (e) {
      console.warn(`Qwen: failed to read saved auth: ${e?.message || e}`);
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
    return qwenRunComplete({
      modelId,
      prompt,
      auth,
      onText,
      onThinking,
      signal,
      threadKey,
      messagesCount,
    });
  }
}
