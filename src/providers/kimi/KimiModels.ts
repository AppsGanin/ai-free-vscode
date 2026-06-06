import { createProviderModelIdResolver } from "../common/ModelIdResolver";
import type { AIModelInfo } from "../types";

// Kimi (Moonshot) веб-версия kimi.com — флагман K2.5.
export const KIMI_MODELS: AIModelInfo[] = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    family: "Kimi",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: { streaming: true, thinking: true },
  },
];

/** Алиасы: короткое имя → канонический ID */
export const KIMI_MODEL_ALIASES: Record<string, string> = {
  kimi: "kimi-k2.5",
  "kimi-k2.5": "kimi-k2.5",
  "kimi-k2": "kimi-k2.5",
  k2: "kimi-k2.5",
  "k2.5": "kimi-k2.5",
  default: "kimi-k2.5",
};

const KIMI_MODEL_ID_RESOLVER = createProviderModelIdResolver({
  aliases: KIMI_MODEL_ALIASES,
});

/** Разрешает алиас в канонический ID модели */
export function resolveKimiModelId(id: string): string {
  return KIMI_MODEL_ID_RESOLVER.resolveModelId(id);
}
