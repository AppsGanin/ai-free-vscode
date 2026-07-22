import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

// Kimi (Moonshot) web app kimi.com — flagship K2.5 only.
export const KIMI_MODELS: AIModelInfo[] = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    family: "Kimi",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: {
      streaming: true,
      thinking: true,
      chat: false,
      commit: true,
      suggestions: true,
      fix: true,
    },
  },
];

export const resolveKimiModelId = aliasResolver({
  kimi: "kimi-k2.5",
  "kimi-k2": "kimi-k2.5",
  k2: "kimi-k2.5",
  "k2.5": "kimi-k2.5",
  default: "kimi-k2.5",
});
