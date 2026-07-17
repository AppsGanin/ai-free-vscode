import * as vscode from "vscode";
import { log } from "../logger";

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
}

export const COMMIT_FEATURE: ModelFeature = {
  section: "freeAI.commit",
  logTag: "commit",
  title: "Commit message model",
};

export const SUGGESTIONS_FEATURE: ModelFeature = {
  section: "freeAI.suggestions",
  logTag: "suggestions",
  title: "Completions model",
};

export const FIX_FEATURE: ModelFeature = {
  section: "freeAI.fix",
  logTag: "fix",
  title: "Fix problem model",
};

function configuredModelId(feature: ModelFeature): string {
  return String(
    vscode.workspace.getConfiguration(feature.section).get("model", AUTO),
  ).trim();
}

function matches(model: vscode.LanguageModelChat, configured: string): boolean {
  return (
    model.id === configured ||
    model.family === configured ||
    model.name === configured
  );
}

/**
 * Модель для фичи по её настройке `<section>.model`.
 * `auto` (или недоступная модель) → первая доступная.
 */
export async function resolveFeatureModel(
  feature: ModelFeature,
): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
  if (models.length === 0) {
    return undefined;
  }

  const configured = configuredModelId(feature);
  if (configured && configured.toLowerCase() !== AUTO) {
    const found = models.find((m) => matches(m, configured));
    if (found) {
      return found;
    }
    log(
      `[${feature.logTag}] configured model "${configured}" not available, falling back to first of ${models.length}`,
    );
  }

  return models[0];
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
  const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
  if (models.length === 0) {
    await promptNoModels();
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
