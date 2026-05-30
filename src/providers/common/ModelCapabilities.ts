import type { AIModelCapabilities, AIModelInfo } from "../types";

export type AIModelCapabilityName = keyof AIModelCapabilities;

export function findModelById(
  models: readonly AIModelInfo[],
  modelId: string,
): AIModelInfo | undefined {
  const normalizedModelId = modelId.toLowerCase();
  return models.find((model) => model.id.toLowerCase() === normalizedModelId);
}

export function modelSupportsCapability(
  model: AIModelInfo | undefined,
  capability: AIModelCapabilityName,
): boolean {
  return Boolean(model?.capabilities?.[capability]);
}

export function modelSupportsCapabilityById(
  models: readonly AIModelInfo[],
  modelId: string,
  capability: AIModelCapabilityName,
): boolean {
  return modelSupportsCapability(findModelById(models, modelId), capability);
}

export function supportsThinking(
  models: readonly AIModelInfo[],
  modelId: string,
): boolean {
  return modelSupportsCapabilityById(models, modelId, "thinking");
}

export function supportsImageInput(
  models: readonly AIModelInfo[],
  modelId: string,
): boolean {
  return modelSupportsCapabilityById(models, modelId, "imageInput");
}

export function supportsToolCalling(
  models: readonly AIModelInfo[],
  modelId: string,
): boolean {
  return modelSupportsCapabilityById(models, modelId, "toolCalling");
}
