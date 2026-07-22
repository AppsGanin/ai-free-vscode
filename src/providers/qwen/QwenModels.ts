import { createProviderModelIdResolver } from "../common/ModelIdResolver";
import type { AIModelInfo } from "../types";

// Актуальный список моделей получен с https://chat.qwen.ai/api/models
// Оставлены только стабильные флагманы линеек: без preview-веток, без малых и
// A3B-моделей (ломают tool calling) и без Omni (нет thinking).
export const QWEN_MODELS: AIModelInfo[] = [
  // ─── Qwen 3.7 ────────────────────────────────────────────────────────────
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
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
  {
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    family: "Qwen3.7",
    maxInputTokens: 1000000,
    maxOutputTokens: 65536,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
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
];

/** Алиасы: короткое имя → канонический ID */
export const QWEN_MODEL_ALIASES: Record<string, string> = {
  // Qwen 3.7
  "qwen3.7": "qwen3.7-max",
  // Qwen 3.6
  "qwen3.6": "qwen3.6-plus",
  // Qwen 3.5
  "qwen3.5": "qwen3.5-plus",
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
