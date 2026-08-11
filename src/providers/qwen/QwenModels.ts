import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

// From https://chat.qwen.ai/api/models — stable flagships only: no preview
// branches, no small/A3B models (they break tool calling), no Omni (no thinking).

const FEATURES = {
  chat: true,
  commit: true,
  suggestions: true,
  fix: true,
} as const;

const BASE = {
  maxInputTokens: 1000000,
  maxOutputTokens: 65536,
} as const;

export const QWEN_MODELS: AIModelInfo[] = [
  {
    ...BASE,
    id: "qwen3.8-max",
    name: "Qwen3.8 Max",
    family: "Qwen3.8",
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
      ...FEATURES,
    },
  },
  {
    ...BASE,
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus",
    family: "Qwen3.7",
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
      ...FEATURES,
    },
  },
  {
    ...BASE,
    id: "qwen3.7-max",
    name: "Qwen3.7 Max",
    family: "Qwen3.7",
    capabilities: {
      toolCalling: true,
      streaming: true,
      thinking: true,
      ...FEATURES,
    },
  },
  {
    ...BASE,
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus",
    family: "Qwen3.6",
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
      ...FEATURES,
    },
  },
  {
    ...BASE,
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus",
    family: "Qwen3.5",
    capabilities: {
      toolCalling: true,
      streaming: true,
      imageInput: true,
      thinking: true,
      ...FEATURES,
    },
  },
];

export const resolveModelId = aliasResolver({
  "qwen3.8": "qwen3.8-max",
  "qwen3.7": "qwen3.7-max",
  "qwen3.6": "qwen3.6-plus",
  "qwen3.5": "qwen3.5-plus",
  "qwen-plus": "qwen3.6-plus",
});
