import * as vscode from "vscode";
import { errToString, log } from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import type { AIModelInfo } from "../providers/types";
import { promptSignIn } from "./util";

const AUTO = "auto";

/** A feature with its own `<section>.model` setting and picker command. */
export interface ModelFeature {
  /** Settings section, e.g. "freeAI.commit". */
  section: string;
  /** Log prefix, e.g. "commit". */
  logTag: string;
  /** QuickPick title, e.g. "Commit message model". */
  title: string;
  /** Model capability the feature requires. */
  capability: "commit" | "suggestions" | "fix";
}

export const COMMIT_FEATURE: ModelFeature = {
  section: "freeAI.commit",
  logTag: "commit",
  title: "Commit message model",
  capability: "commit",
};

export const SUGGESTIONS_FEATURE: ModelFeature = {
  section: "freeAI.suggestions",
  logTag: "suggestions",
  title: "Completions model",
  capability: "suggestions",
};

export const FIX_FEATURE: ModelFeature = {
  section: "freeAI.fix",
  logTag: "fix",
  title: "Fix problem model",
  capability: "fix",
};

/** A model ready to answer a feature request. */
export interface FeatureModel {
  id: string;
  name: string;
  family: string;
  /** Streams the answer text: features need neither thinking nor tool calls. */
  sendText(
    prompts: string[],
    options: { thinkingMode?: "on" | "off" | "auto" },
    token: vscode.CancellationToken,
  ): AsyncIterable<string>;
}

/**
 * Features talk to the provider directly instead of going through `vscode.lm`:
 * there the model list is shared with chat, so a model hidden from chat
 * (`capabilities.chat: false`) would be indistinguishable from an absent one.
 */
let backend:
  { provider: BaseAIProvider; secrets: vscode.SecretStorage } | undefined;

export function setFeatureBackend(
  provider: BaseAIProvider,
  secrets: vscode.SecretStorage,
): void {
  backend = { provider, secrets };
}

/**
 * Model for a feature according to its `<section>.model` setting.
 * `auto` — or an unavailable model — falls back to the first available one.
 *
 * The result carries a retry chain: if the chosen backend fails outright, the
 * request is repeated against the other signed-in providers.
 */
export async function resolveFeatureModel(
  feature: ModelFeature,
): Promise<FeatureModel | undefined> {
  const models = await modelsForFeature(feature);
  if (models.length === 0) {
    log(`[${feature.logTag}] no signed-in model supports this feature`);
    return undefined;
  }

  const configured = configuredModelId(feature);
  let primary = models[0];
  if (configured && configured.toLowerCase() !== AUTO) {
    const found = models.find((m) => matches(m, configured));
    if (found) primary = found;
    else
      log(
        `[${feature.logTag}] configured model "${configured}" is unavailable here, falling back to first of ${models.length}`,
      );
  }

  const chain = [primary, ...otherProviderModels(primary, models)];
  if (chain.length > 1) {
    log(
      `[${feature.logTag}] backup providers: ${chain
        .slice(1)
        .map((m) => m.id)
        .join(", ")}`,
    );
  }
  return toFeatureModel(chain, feature);
}

/**
 * `collectModels` namespaces every family as `<provider>/<family>`, so the tag
 * in front is the sub-provider a model belongs to.
 */
function providerTagOf(model: AIModelInfo): string {
  return model.family.split("/")[0];
}

/**
 * The best model of each *other* signed-in provider, in list order. One per
 * provider: a second model of a backend that just failed would fail the same
 * way, so retrying it only adds latency.
 */
function otherProviderModels(
  primary: AIModelInfo,
  models: AIModelInfo[],
): AIModelInfo[] {
  const seen = new Set([providerTagOf(primary)]);
  const backups: AIModelInfo[] = [];

  for (const model of models) {
    const tag = providerTagOf(model);
    if (seen.has(tag)) continue;
    seen.add(tag);
    backups.push(model);
  }
  return backups;
}

/** QuickPick that writes the choice to `<section>.model` (Global). */
export async function selectFeatureModel(feature: ModelFeature): Promise<void> {
  const models = await modelsForFeature(feature);
  if (models.length === 0) {
    const anySignedIn =
      !!backend &&
      (await backend.provider.getAvailableModels(backend.secrets)).length > 0;
    await (anySignedIn
      ? vscode.window.showWarningMessage(
          `${feature.title}: none of the signed-in models support this. Sign in to another provider.`,
        )
      : promptSignIn());
    return;
  }

  const configured = configuredModelId(feature);
  const isAuto = !configured || configured.toLowerCase() === AUTO;
  const mark = (active: boolean) => (active ? "$(check) " : "");

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `${mark(isAuto)}Auto (first available)`,
        description: AUTO,
        modelId: AUTO,
      },
      ...models.map((m) => ({
        label: `${mark(!isAuto && matches(m, configured))}${m.name}`,
        description: m.id,
        detail: m.family,
        modelId: m.id,
      })),
    ],
    { title: feature.title, placeHolder: "Select a model" },
  );
  if (!picked) return;

  await vscode.workspace
    .getConfiguration(feature.section)
    .update("model", picked.modelId, vscode.ConfigurationTarget.Global);

  log(`[${feature.logTag}] model set to ${picked.modelId}`);
  vscode.window.showInformationMessage(
    `${feature.title}: ${picked.label.replace(/^\$\(check\) /, "")}`,
  );
}

/** Signed-in models suitable for the feature. */
async function modelsForFeature(feature: ModelFeature): Promise<AIModelInfo[]> {
  if (!backend) return [];
  const available = await backend.provider.getAvailableModels(backend.secrets);
  return available.filter((m) => m.capabilities[feature.capability] !== false);
}

function configuredModelId(feature: ModelFeature): string {
  return String(
    vscode.workspace.getConfiguration(feature.section).get("model", AUTO),
  ).trim();
}

function matches(model: AIModelInfo, configured: string): boolean {
  return (
    model.id === configured ||
    model.family === configured ||
    model.name === configured
  );
}

/** @param chain the chosen model first, then one model per backup provider. */
function toFeatureModel(
  chain: AIModelInfo[],
  feature: ModelFeature,
): FeatureModel {
  const { provider, secrets } = backend!;
  const [info] = chain;

  return {
    id: info.id,
    name: info.name,
    family: info.family,
    async *sendText(prompts, options, token) {
      const messages = prompts.map((text) => ({
        role: "user" as const,
        content: text,
      }));

      for (let index = 0; index < chain.length; index++) {
        const candidate = chain[index];
        const abort = new AbortController();
        const cancelled = token.onCancellationRequested(() => abort.abort());
        // Callers render chunks as they arrive, so once anything is out a
        // second backend would append to a half-written answer.
        let yielded = false;

        try {
          const stream = provider.sendMessageStream(
            {
              model: candidate.id,
              messages,
              toolMode: "none",
              thinkingMode: options.thinkingMode,
              abortSignal: abort.signal,
            },
            secrets,
          );

          for await (const chunk of stream) {
            if (chunk.type === "text") {
              yielded = true;
              yield chunk.content;
            }
          }
          return;
        } catch (err) {
          const next = chain[index + 1];
          if (yielded || !next || token.isCancellationRequested) throw err;
          log(
            `[${feature.logTag}] ${candidate.id} failed (${errToString(err)}) — retrying on ${next.id}`,
          );
        } finally {
          cancelled.dispose();
        }
      }
    },
  };
}
