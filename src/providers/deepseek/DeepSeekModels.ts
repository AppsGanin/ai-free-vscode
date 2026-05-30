import { createProviderModelIdResolver } from "../common/ModelIdResolver";
import type { AIModelInfo } from "../types";

export const DEEPSEEK_MODELS: AIModelInfo[] = [
  {
    id: "deepseek-default",
    name: "DeepSeek",
    family: "DeepSeek",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { toolCalling: true, streaming: true, thinking: true },
  },
];

/** Алиасы: короткое имя → канонический ID модели */
export const DEEPSEEK_MODEL_ALIASES: Record<string, string> = {
  deepseek: "deepseek-default",
  "deepseek-default": "deepseek-default",
  default: "deepseek-default",
};

export const DEEPSEEK_API_MODEL_TYPE_BY_MODEL_ID: Record<string, string> = {
  "deepseek-default": "default",
};

const DEEPSEEK_MODEL_ID_RESOLVER = createProviderModelIdResolver({
  aliases: DEEPSEEK_MODEL_ALIASES,
  apiModelTypeByModelId: DEEPSEEK_API_MODEL_TYPE_BY_MODEL_ID,
});

/** Разрешает алиас в канонический ID модели */
export function resolveDeepSeekModelId(id: string): string {
  return DEEPSEEK_MODEL_ID_RESOLVER.resolveModelId(id);
}

/** Преобразует канонический ID к model_type, ожидаемому API DeepSeek */
export function toDeepSeekApiModelType(id: string): string {
  return DEEPSEEK_MODEL_ID_RESOLVER.toApiModelType(id);
}
