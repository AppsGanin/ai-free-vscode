import * as vscode from "vscode";
import { log } from "../logger";
import {
  COMMIT_FEATURE,
  promptNoModels,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";

const VENDOR = "free-ai-vscode";
const MAX_DIFF_CHARS = 16000;

const DEFAULT_PROMPT = [
  "Generate a commit message for the git diff below.",
  "Requirements:",
  "- Use Conventional Commits format: type(scope): summary (type = feat|fix|docs|style|refactor|perf|test|build|ci|chore).",
  "- Subject on a single line, imperative mood, max 72 characters.",
  "- Write the message in English.",
  "- For significant changes, add a short body after a blank line (a bullet list is allowed).",
  "- Reply with ONLY the commit message text: no markdown fences, no quotes, no explanations.",
].join("\n");

// ─── Минимальный тип API встроенного git-расширения VS Code ────────────────
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}

interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export function registerCommitMessageCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${VENDOR}.generateCommitMessage`,
      (scmArg?: unknown) => generateCommitMessage(scmArg),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${VENDOR}.selectCommitModel`, () =>
      selectFeatureModel(COMMIT_FEATURE),
    ),
  );
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports?.enabled) {
      return undefined;
    }
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

function resolveRepository(
  api: GitAPI,
  scmArg?: unknown,
): GitRepository | undefined {
  // Команда из меню scm/inputBox получает SourceControl с rootUri.
  const rootUri = (scmArg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (rootUri) {
    const matched =
      api.getRepository(rootUri) ??
      api.repositories.find(
        (r) => r.rootUri.toString() === rootUri.toString(),
      );
    if (matched) {
      return matched;
    }
  }

  if (api.repositories.length === 1) {
    return api.repositories[0];
  }

  // Несколько репозиториев и не удалось сопоставить — берём первый.
  return api.repositories[0];
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();

  // Снимаем возможные markdown-ограждения ```...```.
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/);
  if (fenced) {
    text = fenced[1].trim();
  }

  // Снимаем обрамляющие кавычки, если модель обернула всё сообщение.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

async function generateCommitMessage(scmArg?: unknown): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration("freeAI")
    .get<boolean>("commit.enabled", true);
  if (!enabled) {
    vscode.window.showInformationMessage(
      "Commit message generation is disabled (freeAI.commit.enabled).",
    );
    return;
  }

  const api = await getGitApi();
  if (!api) {
    vscode.window.showErrorMessage(
      "The built-in Git extension is unavailable or disabled.",
    );
    return;
  }

  const repo = resolveRepository(api, scmArg);
  if (!repo) {
    vscode.window.showErrorMessage("Git repository not found.");
    return;
  }

  let diff = "";
  try {
    const staged = (await repo.diff(true)) ?? "";
    diff = staged.trim() ? staged : (await repo.diff(false)) ?? "";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to get git diff: ${msg}`);
    return;
  }

  if (!diff.trim()) {
    vscode.window.showInformationMessage(
      "No changes to generate a commit message from.",
    );
    return;
  }

  const model = await resolveFeatureModel(COMMIT_FEATURE);
  if (!model) {
    await promptNoModels();
    return;
  }

  let boundedDiff = diff;
  if (boundedDiff.length > MAX_DIFF_CHARS) {
    boundedDiff = `${boundedDiff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated: showing first ${MAX_DIFF_CHARS} chars]`;
  }

  const instructions = String(
    vscode.workspace
      .getConfiguration("freeAI.commit")
      .get("prompt", DEFAULT_PROMPT),
  ).trim();

  const userPrompt = `${instructions || DEFAULT_PROMPT}\n\n=== git diff ===\n${boundedDiff}`;

  // Сохраняем то, что пользователь уже мог напечатать, чтобы вернуть при отмене.
  const previousValue = repo.inputBox.value;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: `Generating commit message (${model.name})…`,
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        const response = model.sendText(
          [userPrompt],
          // Reasoning не нужен для коммитов — только добавляет задержку.
          { thinkingMode: "off" },
          token,
        );

        let acc = "";
        for await (const part of response) {
          if (token.isCancellationRequested) {
            break;
          }
          acc += part;
          // Живой предпросмотр прямо в поле ввода коммита.
          repo.inputBox.value = cleanCommitMessage(acc);
        }

        if (token.isCancellationRequested) {
          repo.inputBox.value = previousValue;
          return;
        }

        const finalMessage = cleanCommitMessage(acc);
        repo.inputBox.value = finalMessage || previousValue;

        if (!finalMessage) {
          vscode.window.showWarningMessage(
            "The model returned an empty commit message.",
          );
        }
        log(
          `[commit] generated message model=${model.id} chars=${finalMessage.length}`,
        );
      } catch (err) {
        repo.inputBox.value = previousValue;
        const msg = err instanceof Error ? err.message : String(err);
        log(`[commit] generation error: ${msg}`);
        vscode.window.showErrorMessage(
          `Failed to generate commit message: ${msg}`,
        );
      }
    },
  );
}
