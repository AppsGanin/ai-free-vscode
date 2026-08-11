import * as vscode from "vscode";
import { log } from "../logger";
import {
  COMMIT_FEATURE,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";
import { VENDOR, promptSignIn, stripCodeFences } from "./util";

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

// ─── Minimal surface of the built-in git extension API ──────────────────────
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
    vscode.commands.registerCommand(`${VENDOR}.selectCommitModel`, () =>
      selectFeatureModel(COMMIT_FEATURE),
    ),
  );
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports?.enabled ? exports.getAPI(1) : undefined;
  } catch {
    return undefined;
  }
}

function resolveRepository(
  api: GitAPI,
  scmArg?: unknown,
): GitRepository | undefined {
  // Invoked from the scm/inputBox menu we get a SourceControl with a rootUri.
  const rootUri = (scmArg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  if (rootUri) {
    const matched =
      api.getRepository(rootUri) ??
      api.repositories.find((r) => r.rootUri.toString() === rootUri.toString());
    if (matched) return matched;
  }
  return api.repositories[0];
}

function cleanCommitMessage(raw: string): string {
  const text = stripCodeFences(raw.trim()).trim();
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`"));
  return quoted ? text.slice(1, -1).trim() : text;
}

async function generateCommitMessage(scmArg?: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration("freeAI");
  if (!config.get<boolean>("commit.enabled", true)) {
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
    // Staged changes first; fall back to the working tree.
    const staged = (await repo.diff(true)) ?? "";
    diff = staged.trim() ? staged : ((await repo.diff(false)) ?? "");
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to get git diff: ${message(err)}`);
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
    await promptSignIn();
    return;
  }

  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated: showing first ${MAX_DIFF_CHARS} chars]`;
  }

  const instructions =
    String(
      vscode.workspace
        .getConfiguration("freeAI.commit")
        .get("prompt", DEFAULT_PROMPT),
    ).trim() || DEFAULT_PROMPT;
  const userPrompt = `${instructions}\n\n=== git diff ===\n${diff}`;

  // Keep whatever the user already typed, to restore it on cancel or failure.
  const previousValue = repo.inputBox.value;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      // No model name: the request can switch to a backup provider mid-flight,
      // and a title fixed at the start would name the wrong one.
      title: "Generating commit message…",
      cancellable: true,
    },
    async (_progress, token) => {
      try {
        // Reasoning only adds latency for commit messages.
        const response = model.sendText(
          [userPrompt],
          { thinkingMode: "off" },
          token,
        );

        let acc = "";
        for await (const part of response) {
          if (token.isCancellationRequested) break;
          acc += part;
          // Live preview straight in the commit input box.
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
          `[commit] generated model=${model.id} chars=${finalMessage.length}`,
        );
      } catch (err) {
        repo.inputBox.value = previousValue;
        log(`[commit] generation error: ${message(err)}`);
        vscode.window.showErrorMessage(
          `Failed to generate commit message: ${message(err)}`,
        );
      }
    },
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
