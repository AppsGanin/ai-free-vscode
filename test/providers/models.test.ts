import { describe, expect, it } from "vitest";
import { DEEPSEEK_MODELS } from "../../src/providers/deepseek/DeepSeekModels";
import { KIMI_MODELS } from "../../src/providers/kimi/KimiModels";
import { QWEN_MODELS } from "../../src/providers/qwen/QwenModels";
import type { AIModelInfo } from "../../src/providers/types";
import { ZAI_MODELS } from "../../src/providers/zai/ZaiModels";

const PROVIDERS: Record<string, AIModelInfo[]> = {
  qwen: QWEN_MODELS,
  deepseek: DEEPSEEK_MODELS,
  kimi: KIMI_MODELS,
  zai: ZAI_MODELS,
};

describe("built-in model lists", () => {
  it("never reuse a model id across providers (the first one would win)", () => {
    const seen = new Map<string, string>();
    for (const [provider, models] of Object.entries(PROVIDERS)) {
      for (const model of models) {
        expect(seen.get(model.id), `${model.id} in ${provider}`).toBeUndefined();
        seen.set(model.id, provider);
      }
    }
  });

  for (const [provider, models] of Object.entries(PROVIDERS)) {
    describe(provider, () => {
      it("has at least one model", () => {
        expect(models.length).toBeGreaterThan(0);
      });

      it.each(models.map((m) => [m.id, m] as const))(
        "%s has sane limits",
        (_id, model) => {
          expect(model.maxInputTokens).toBeGreaterThan(0);
          expect(model.maxOutputTokens).toBeGreaterThan(0);
          expect(model.name.trim()).not.toBe("");
        },
      );

      // Copilot Chat's Agent mode — the default — lists only models that
      // declare tool calling. Missing it made the Z.ai models invisible.
      it.each(
        models.filter((m) => m.capabilities.chat !== false).map((m) => [m.id] as const),
      )("%s is usable in Agent mode", (id) => {
        const model = models.find((m) => m.id === id);
        expect(model?.capabilities.toolCalling).toBe(true);
      });
    });
  }
});
