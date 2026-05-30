import { createProviderModelIdResolver } from "../common/ModelIdResolver";
import type { AIModelInfo } from "../types";

// Актуальный список моделей получен с https://chat.qwen.ai/api/models
export const QWEN_MODELS: AIModelInfo[] = [
  // ─── Qwen 3.7 ────────────────────────────────────────────────────────────
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    family: "Qwen3.7",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
  {
    id: "qwen-latest-series-invite-beta-v24",
    name: "Qwen3.7 Max (Preview)",
    family: "Qwen3.7",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
  {
    id: "qwen-latest-series-invite-beta-v16",
    name: "Qwen3.7 Plus (Preview)",
    family: "Qwen3.7",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  // ─── Qwen 3.6 ────────────────────────────────────────────────────────────
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    family: "Qwen3.6",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.6-max-preview",
    name: "Qwen3.6 Max (Preview)",
    family: "Qwen3.6",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
  {
    id: "qwen3.6-plus-preview",
    name: "Qwen3.6 Plus (Preview)",
    family: "Qwen3.6",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
  {
    id: "qwen3.6-27b",
    name: "Qwen3.6 27B",
    family: "Qwen3.6",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.6-35b-a3b",
    name: "Qwen3.6 35B-A3B",
    family: "Qwen3.6",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  // ─── Qwen 3.5 ────────────────────────────────────────────────────────────
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    family: "Qwen3.5",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-flash",
    name: "Qwen3.5 Flash",
    family: "Qwen3.5",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-max-2026-03-08",
    name: "Qwen3.5 Max (Preview)",
    family: "Qwen3.5",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
  {
    id: "qwen3.5-397b-a17b",
    name: "Qwen3.5 397B-A17B",
    family: "Qwen3.5",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-122b-a10b",
    name: "Qwen3.5 122B-A10B",
    family: "Qwen3.5",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-27b",
    name: "Qwen3.5 27B",
    family: "Qwen3.5",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-35b-a3b",
    name: "Qwen3.5 35B-A3B",
    family: "Qwen3.5",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3.5-omni-plus",
    name: "Qwen3.5 Omni Plus",
    family: "Qwen3.5 Omni",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: false,
    },
  },
  {
    id: "qwen3.5-omni-flash",
    name: "Qwen3.5 Omni Flash",
    family: "Qwen3.5 Omni",
    maxInputTokens: 262144,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: false,
    },
  },
  // ─── Qwen 3 ──────────────────────────────────────────────────────────────
  {
    id: "qwen3-max-2026-01-23",
    name: "Qwen3 Max",
    family: "Qwen3",
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen-plus-2025-07-28",
    name: "Qwen3 235B-A22B-2507",
    family: "Qwen3",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder",
    family: "Qwen3",
    maxInputTokens: 1048576,
    maxOutputTokens: 65536,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3-vl-plus",
    name: "Qwen3 VL 235B-A22B",
    family: "Qwen3 Vision",
    maxInputTokens: 262144,
    maxOutputTokens: 32768,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: "qwen3-omni-flash-2025-12-01",
    name: "Qwen3 Omni Flash",
    family: "Qwen3 Omni",
    maxInputTokens: 65536,
    maxOutputTokens: 13684,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: false,
    },
  },
  // ─── Qwen 2.5 ────────────────────────────────────────────────────────────
  {
    id: "qwen-max-latest",
    name: "Qwen2.5 Max",
    family: "Qwen2.5",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
    },
  },
];

/** Алиасы: короткое имя → канонический ID */
export const QWEN_MODEL_ALIASES: Record<string, string> = {
  // Qwen 3.7
  "qwen3.7": "qwen3.7-max",
  "qwen3.7-max-preview": "qwen-latest-series-invite-beta-v24",
  "qwen3.7-plus-preview": "qwen-latest-series-invite-beta-v16",
  // Qwen 3.6
  "qwen3.6": "qwen3.6-plus",
  "qwen-preview": "qwen3.6-max-preview",
  // Qwen 3.5
  "qwen3.5": "qwen3.5-plus",
  "qwen3.5-max": "qwen3.5-max-2026-03-08",
  "qwen3.5-397b": "qwen3.5-397b-a17b",
  "qwen3.5-122b": "qwen3.5-122b-a10b",
  "qwen3.5-35b": "qwen3.5-35b-a3b",
  // Qwen 3
  qwen3: "qwen3-max-2026-01-23",
  "qwen3-max": "qwen3-max-2026-01-23",
  "qwen3-235b": "qwen-plus-2025-07-28",
  "qwen3-coder": "qwen3-coder-plus",
  "qwen3-vl": "qwen3-vl-plus",
  "qwen3-omni": "qwen3-omni-flash-2025-12-01",
  // Qwen 2.5
  "qwen-max": "qwen-max-latest",
  "qwen2.5-max": "qwen-max-latest",
  // Generic
  "qwen-plus": "qwen3.6-plus",
};

const QWEN_MODEL_ID_RESOLVER = createProviderModelIdResolver({
  aliases: QWEN_MODEL_ALIASES,
});

/** Разрешает алиас в канонический ID модели */
export function resolveModelId(id: string): string {
  return QWEN_MODEL_ID_RESOLVER.resolveModelId(id);
}

/** Преобразует ID модели к model_type, ожидаемому API Qwen */
export function toQwenApiModelType(id: string): string {
  return QWEN_MODEL_ID_RESOLVER.toApiModelType(id);
}
