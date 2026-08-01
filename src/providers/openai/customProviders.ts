import * as vscode from "vscode";
import { log } from "../../logger";
import {
  OpenAICompatProvider,
  createModelCache,
  type CustomModelCache,
} from "./OpenAICompatProvider";
import { readCustomProviders } from "./customConfig";

/**
 * Builds a provider per configured endpoint. Called on activation and again on
 * every settings change, so editing an endpoint takes effect without a reload.
 */
export function createCustomProviders(
  cache: CustomModelCache,
): OpenAICompatProvider[] {
  const providers = readCustomProviders()
    .filter((config) => config.enabled !== false)
    .map((config) => new OpenAICompatProvider(config, cache));

  if (providers.length > 0) {
    log(
      `[custom] endpoints: ${providers.map((p) => `${p.config.name} (${p.config.baseUrl})`).join(", ")}`,
    );
  }
  return providers;
}

export { createModelCache };
export type { CustomModelCache };

/** Warms up the discovered model lists in the background. */
export function warmUpModels(
  providers: OpenAICompatProvider[],
  secrets: vscode.SecretStorage,
): void {
  for (const provider of providers) {
    void provider.ensureModels(secrets);
  }
}
