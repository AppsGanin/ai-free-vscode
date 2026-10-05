import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

// toolCalling is what puts a model into Copilot Chat's Agent mode picker; the
// calls themselves go through the shared text protocol (see ToolCalling.ts).
const CAPABILITIES = {
  toolCalling: true,
  streaming: true,
  thinking: true,
  chat: true,
  commit: true,
  suggestions: true,
  fix: true,
} as const;

// Z.ai web app chat.z.ai (Zhipu GLM). The GLM-5.x models need a signed-in
// account — a guest session is refused with "not available for current user
// level".
export const ZAI_MODELS: AIModelInfo[] = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    family: "GLM",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: CAPABILITIES,
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    family: "GLM",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: CAPABILITIES,
  },
  {
    id: "glm-5.3-flash",
    name: "GLM-5.3 Flash",
    family: "GLM",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: CAPABILITIES,
  },
  {
    id: "glm-4.7",
    name: "GLM-4.7",
    family: "GLM",
    maxInputTokens: 131072,
    maxOutputTokens: 16384,
    capabilities: CAPABILITIES,
  },
];

export const resolveZaiModelId = aliasResolver({
  glm: "glm-5.3",
  "glm-5": "glm-5.3",
  "glm-flash": "glm-5.3-flash",
  default: "glm-5.3",
});

/**
 * Our ids are the readable ones; the web app knows the flash model only by its
 * preview codename.
 */
const UPSTREAM_IDS: Record<string, string> = {
  "glm-5.3-flash": "x-preview-l",
};

export function upstreamZaiModelId(modelId: string): string {
  return UPSTREAM_IDS[modelId] ?? modelId;
}
