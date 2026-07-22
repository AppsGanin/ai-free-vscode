import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

const CAPABILITIES = {
  toolCalling: true,
  streaming: true,
  thinking: true,
  chat: true,
  commit: true,
  suggestions: true,
  fix: true,
} as const;

export const DEEPSEEK_MODELS: AIModelInfo[] = [
  {
    id: "deepseek-default",
    name: "DeepSeek",
    family: "DeepSeek",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { ...CAPABILITIES },
  },
  {
    id: "deepseek-expert",
    name: "DeepSeek Expert",
    family: "DeepSeek",
    version: "1.0.0",
    maxInputTokens: 131072,
    maxOutputTokens: 8192,
    capabilities: { ...CAPABILITIES },
  },
];

export const resolveDeepSeekModelId = aliasResolver({
  deepseek: "deepseek-default",
  default: "deepseek-default",
  expert: "deepseek-expert",
});

/** Canonical id → `model_type` expected by the DeepSeek API. */
export function toDeepSeekApiModelType(id: string): string {
  return resolveDeepSeekModelId(id) === "deepseek-expert"
    ? "expert"
    : "default";
}
