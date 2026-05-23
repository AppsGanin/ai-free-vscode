import { QwenClient } from "./client.mjs";
export const MODELS = [
  {
    id: "qwen-max",
    name: "Qwen2.5-Max",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "Qwen via browser session (no API key)",
  },
  {
    id: "qwen-plus",
    name: "Qwen3.6-Plus",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "Qwen via browser session (no API key)",
  },
  {
    id: "qwen3-max",
    name: "Qwen3-Max",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "Qwen via browser session (no API key)",
  },
  {
    id: "qwen-coder",
    name: "Qwen3-Coder",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "Qwen via browser session (no API key)",
  },
  {
    id: "qwen-flash",
    name: "Qwen3.5-Flash (fast)",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: "Qwen via browser session (no API key)",
  },
];

/** Model id → Qwen API model name */
export const MODEL_PARAMS = {
  "qwen-max": { apiName: "qwen-max-latest" },
  "qwen-plus": { apiName: "qwen3.6-plus" },
  "qwen3-max": { apiName: "qwen3-max-2026-01-23" },
  "qwen-coder": { apiName: "qwen3-coder-plus" },
  "qwen-flash": { apiName: "qwen3.5-flash" },
};

/**
 * Runs a Qwen completion and streams text via onText().
 * Throws an error with `isNotSignedIn=true` if auth is missing.
 *
 * @param {{
 *   modelId: string,
 *   prompt: string,
 *   auth: { token: string } | null,
 *   onText: (text: string) => Promise<void>,
 *   onThinking?: (text: string) => Promise<void>,
 *   signal: AbortSignal,
 *   threadKey?: string,
 * }} opts
 */

/** threadKey → chatId cache so the same VS Code thread reuses one Qwen chat */
const chatIdCache = new Map();

export async function runComplete({
  modelId,
  prompt,
  auth,
  onText,
  onThinking,
  signal,
  threadKey,
  messagesCount,
}) {
  if (!auth?.token) {
    const err = new Error(
      '⚠️ Qwen is not signed in. Run the "Qwen: Sign In" command.',
    );
    err.isNotSignedIn = true;
    throw err;
  }

  const client = new QwenClient({ token: auth.token, debug: true });
  const apiModel = MODEL_PARAMS[modelId]?.apiName ?? "qwen-max-latest";
  const cacheKey = threadKey ?? modelId;

  console.debug(
    `[qwen] apiModel=${apiModel} cacheKey=${cacheKey} messagesCount=${messagesCount}`,
  );

  // First message of a new VS Code thread — always start a fresh Qwen chat
  if (messagesCount === 1) {
    chatIdCache.delete(cacheKey);
  }

  // Try cached chatId first, fall back to creating a new chat on failure
  const cachedChatId = chatIdCache.get(cacheKey);
  if (cachedChatId) {
    console.debug(`[qwen] reusing chatId=${cachedChatId}`);
    try {
      const completeOptions = {
        model: apiModel,
        chatId: cachedChatId,
        prompt,
        onText,
        signal,
      };
      if (onThinking) {
        completeOptions.onThinking = onThinking;
      }
      await client.complete(completeOptions);
      return;
    } catch (err) {
      console.debug(
        `[qwen] cached chatId failed (${err.message}), creating new chat`,
      );
      chatIdCache.delete(cacheKey);
    }
  }

  // Create a new chat and cache its ID
  const newChatId = await client.createChat(apiModel);
  chatIdCache.set(cacheKey, newChatId);
  console.debug(`[qwen] new chatId=${newChatId}`);
  const completeOptions = {
    model: apiModel,
    chatId: newChatId,
    prompt,
    onText,
    signal,
  };
  if (onThinking) {
    completeOptions.onThinking = onThinking;
  }
  await client.complete(completeOptions);
}
