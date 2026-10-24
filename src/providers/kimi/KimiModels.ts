import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

// Kimi (Moonshot) web app — kimi.ai (global) or kimi.com (China). One entry:
// the plain chat model the web app offers right now (K2.6 Instant on kimi.ai),
// read from its model list (KimiChatModel). The agent models (K3, K2.8 "OK
// Computer") live inside Kimi's own server sandbox and are left out.
export const KIMI_MODELS: AIModelInfo[] = [
  {
    id: "kimi-instant",
    name: "Kimi Instant",
    family: "Kimi",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    // Kimi still reaches for its own server-side ipython/shell on long tool
    // sessions; KimiApiClient hands those calls to the caller's command tool
    // or asks again (the agent test: 23 turns, 22 calls, all on our side).
    capabilities: {
      streaming: true,
      thinking: true,
      toolCalling: true,
      chat: true,
      commit: true,
      suggestions: true,
      fix: true,
    },
  },
];

export const resolveKimiModelId = aliasResolver({
  kimi: "kimi-instant",
  // Saved settings from before the model list was read.
  "kimi-k2.5": "kimi-instant",
  "kimi-k2": "kimi-instant",
  k2: "kimi-instant",
  "k2.5": "kimi-instant",
  default: "kimi-instant",
});
