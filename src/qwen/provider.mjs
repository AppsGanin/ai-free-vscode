import { isDebugMode } from "../utils/logger.mjs";
import { QwenClient } from "./client.mjs";
const T = "Qwen via browser session (no API key)";

export const MODELS = [
  // ── Qwen3.6 ────────────────────────────────────────────────────────────────
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6-Plus",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.6-max-preview",
    name: "Qwen3.6-Max-Preview",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.6-plus-preview",
    name: "Qwen3.6-Plus-Preview",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.6-35b-a3b",
    name: "Qwen3.6-35B-A3B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.6-27b",
    name: "Qwen3.6-27B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  // ── Qwen3.7 ────────────────────────────────────────────────────────────────
  {
    id: "qwen3.7-max",
    name: "Qwen3.7-Max",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen-latest-series-invite-beta-v24",
    name: "Qwen3.7-Max-Preview",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen-latest-series-invite-beta-v16",
    name: "Qwen3.7-Plus-Preview",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  // ── Qwen3.5 ────────────────────────────────────────────────────────────────
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5-Plus",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-max-2026-03-08",
    name: "Qwen3.5-Max-Preview",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: false },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-flash",
    name: "Qwen3.5-Flash",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-397b-a17b",
    name: "Qwen3.5-397B-A17B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-122b-a10b",
    name: "Qwen3.5-122B-A10B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-27b",
    name: "Qwen3.5-27B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3.5-35b-a3b",
    name: "Qwen3.5-35B-A3B",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  // ── Qwen3 ──────────────────────────────────────────────────────────────────
  {
    id: "qwen3-max-2026-01-23",
    name: "Qwen3-Max",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen-plus-2025-07-28",
    name: "Qwen3-235B-A22B-2507",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  {
    id: "qwen3-coder-plus",
    name: "Qwen3-Coder",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
  // ── Qwen2.5 ────────────────────────────────────────────────────────────────
  {
    id: "qwen-max-latest",
    name: "Qwen2.5-Max",
    family: "qwen",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, imageInput: true },
    tooltip: T,
    params: {},
  },
];

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

  const client = new QwenClient({ token: auth.token, debug: isDebugMode() });
  const apiModel = MODELS.find((m) => m.id === modelId)?.id ?? modelId;
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
      // User/request cancellation must stop immediately — do not fallback.
      if (
        signal?.aborted ||
        err?.name === "AbortError" ||
        err?.code === "ABORT_ERR" ||
        /abort/i.test(String(err?.message ?? ""))
      ) {
        throw err;
      }
      console.debug(
        `[qwen] cached chatId failed (${err.message}), creating new chat`,
      );
      chatIdCache.delete(cacheKey);
    }
  }

  // Create a new chat and cache its ID
  if (signal?.aborted) {
    const abortErr = new Error("Request aborted");
    abortErr.name = "AbortError";
    abortErr.code = "ABORT_ERR";
    throw abortErr;
  }
  const newChatId = await client.createChat(apiModel, signal);
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
