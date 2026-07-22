import * as vscode from "vscode";
import { log } from "../logger";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import type { AIModelInfo } from "../providers/types";

const VENDOR = "free-ai-vscode";
const AUTO = "auto";

/**
 * Описание «фичи» (коммиты, комплишен, фиксы), у которой есть своя настройка
 * `<section>.model` и своя команда смены модели.
 */
export interface ModelFeature {
  /** Секция настроек, например "freeAI.commit". */
  section: string;
  /** Префикс в логах, например "commit". */
  logTag: string;
  /** Заголовок QuickPick, например "Commit message model". */
  title: string;
  /** Возможность модели, которую требует фича. */
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

/** Модель, готовая к запросу от фичи. */
export interface FeatureModel {
  id: string;
  name: string;
  family: string;
  /** Стримит текст ответа: thinking и tool call'ы фичам не нужны. */
  sendText(
    prompts: string[],
    options: { thinkingMode?: "on" | "off" | "auto" },
    token: vscode.CancellationToken,
  ): AsyncIterable<string>;
}

interface FeatureBackend {
  provider: BaseAIProvider;
  secrets: vscode.SecretStorage;
}

/**
 * Фичи ходят в провайдер напрямую, а не через `vscode.lm`: там список моделей
 * общий с чатом, и модель, скрытую из чата (`capabilities.chat: false`), было
 * бы не отличить от недоступной вообще.
 */
let backend: FeatureBackend | undefined;

export function setFeatureBackend(
  provider: BaseAIProvider,
  secrets: vscode.SecretStorage,
): void {
  backend = { provider, secrets };
}

/** Авторизованные модели, пригодные для фичи. */
async function modelsForFeature(feature: ModelFeature): Promise<AIModelInfo[]> {
  if (!backend) {
    return [];
  }
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

function toFeatureModel(info: AIModelInfo): FeatureModel {
  const { provider, secrets } = backend!;

  return {
    id: info.id,
    name: info.name,
    family: info.family,
    async *sendText(prompts, options, token) {
      const abort = new AbortController();
      const cancelled = token.onCancellationRequested(() => abort.abort());

      try {
        const stream = provider.sendMessageStream(
          {
            model: info.id,
            messages: prompts.map((text) => ({
              role: "user" as const,
              content: text,
            })),
            toolMode: "none",
            thinkingMode: options.thinkingMode,
            abortSignal: abort.signal,
          },
          secrets,
        );

        for await (const chunk of stream) {
          if (chunk.type === "text") {
            yield chunk.content;
          }
        }
      } finally {
        cancelled.dispose();
      }
    },
  };
}

/**
 * Модель для фичи по её настройке `<section>.model`.
 * `auto` (или недоступная модель) → первая доступная.
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
  if (configured && configured.toLowerCase() !== AUTO) {
    const found = models.find((m) => matches(m, configured));
    if (found) {
      return toFeatureModel(found);
    }
    log(
      `[${feature.logTag}] configured model "${configured}" is unavailable or not suitable here, falling back to first of ${models.length}`,
    );
  }

  return toFeatureModel(models[0]);
}

/** Уведомление «нет моделей» с кнопкой входа. */
export async function promptNoModels(): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    "No models available. Sign in to Qwen, DeepSeek or Kimi.",
    "Sign In",
  );
  if (action === "Sign In") {
    await vscode.commands.executeCommand(`${VENDOR}.login`);
  }
}

/**
 * QuickPick смены модели для фичи: пишет выбор в `<section>.model` (Global).
 * Текущий выбор помечен галочкой.
 */
export async function selectFeatureModel(feature: ModelFeature): Promise<void> {
  const models = await modelsForFeature(feature);
  if (models.length === 0) {
    const anySignedIn =
      !!backend &&
      (await backend.provider.getAvailableModels(backend.secrets)).length > 0;

    if (anySignedIn) {
      vscode.window.showWarningMessage(
        `${feature.title}: none of the signed-in models support this. Sign in to another provider.`,
      );
    } else {
      await promptNoModels();
    }
    return;
  }

  const configured = configuredModelId(feature);
  const isAuto = !configured || configured.toLowerCase() === AUTO;
  const mark = (active: boolean): string => (active ? "$(check) " : "");

  const items: Array<vscode.QuickPickItem & { modelId: string }> = [
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
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: feature.title,
    placeHolder: "Select a model",
  });
  if (!picked) {
    return;
  }

  await vscode.workspace
    .getConfiguration(feature.section)
    .update("model", picked.modelId, vscode.ConfigurationTarget.Global);

  log(`[${feature.logTag}] model set to ${picked.modelId}`);
  vscode.window.showInformationMessage(
    `${feature.title}: ${picked.label.replace(/^\$\(check\) /, "")}`,
  );
}
