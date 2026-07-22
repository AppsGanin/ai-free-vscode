import * as vscode from "vscode";
import { log } from "../logger";
import {
  SUGGESTIONS_FEATURE,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";
import { VENDOR, stripCodeFences } from "./util";

const SYSTEM_PROMPT = [
  "You are an inline code completion engine inside an IDE.",
  "You are given the code BEFORE the cursor and the code AFTER the cursor.",
  "Output ONLY the code that should be inserted at the cursor position to continue the code naturally.",
  "Rules:",
  "- Do NOT repeat the code that is before or after the cursor.",
  "- Do NOT wrap the output in markdown fences or quotes.",
  "- Do NOT add explanations or comments about your answer.",
  "- Preserve the existing indentation style.",
  "- If no useful completion is possible, return an empty response.",
].join("\n");

/** Past this point we stop waiting and use whatever arrived. */
const SOFT_DEADLINE_MS = 30000;
const MAX_COMPLETION_CHARS = 600;
const MAX_COMPLETION_LINES = 12;
const STATUS_NOTICE_MS = 2500;

/** Status bar item: without it a failed suggestion looks like a dead hotkey. */
class SuggestionStatus {
  private readonly item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  private noticeTimer?: NodeJS.Timeout;

  busy(modelName: string): void {
    this.clearNotice();
    this.item.text = "$(sync~spin) AI Free: suggesting…";
    this.item.tooltip = `Inline suggestion from ${modelName}`;
    this.item.command = undefined;
    this.item.show();
  }

  /** Clickable: leads to the model picker — usually that is the problem. */
  notice(text: string, tooltip: string): void {
    this.clearNotice();
    this.item.text = text;
    this.item.tooltip = `${tooltip} — click to change the completions model`;
    this.item.command = `${VENDOR}.selectSuggestionsModel`;
    this.item.show();
    this.noticeTimer = setTimeout(() => this.idle(), STATUS_NOTICE_MS);
  }

  idle(): void {
    this.clearNotice();
    this.item.hide();
  }

  dispose(): void {
    this.clearNotice();
    this.item.dispose();
  }

  private clearNotice(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
  }
}

class FreeAIInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  /** Sequence number of the latest request; only it owns the status bar. */
  private seq = 0;

  constructor(private readonly status: SuggestionStatus) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = vscode.workspace.getConfiguration("freeAI.suggestions");
    // Manual trigger only: these web sessions are far too slow to fire on every
    // keystroke.
    if (
      !config.get("enabled", false) ||
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      return undefined;
    }

    const model = await resolveFeatureModel(SUGGESTIONS_FEATURE);
    if (!model || token.isCancellationRequested) return undefined;

    const offset = document.offsetAt(position);
    const fullText = document.getText();
    const prefix = fullText
      .slice(0, offset)
      .slice(-boundedNumber(config, "maxPrefixChars", 2000, 200));
    const suffix = fullText
      .slice(offset)
      .slice(0, boundedNumber(config, "maxSuffixChars", 800, 0));
    if (!prefix.trim() && !suffix.trim()) return undefined;

    const userPrompt = [
      `Language: ${document.languageId}`,
      "",
      "=== CODE BEFORE CURSOR ===",
      prefix,
      "=== CODE AFTER CURSOR ===",
      suffix,
      "=== END ===",
      "",
      "Insert the completion at the cursor (between BEFORE and AFTER):",
    ].join("\n");

    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    // A newer request may already own the status bar — never clobber it.
    const mine = ++this.seq;
    const status = {
      busy: (name: string) => mine === this.seq && this.status.busy(name),
      notice: (text: string, tip: string) =>
        mine === this.seq && this.status.notice(text, tip),
      idle: () => mine === this.seq && this.status.idle(),
    };

    // Our own token on top of the editor's, so we can cut generation short.
    const cts = new vscode.CancellationTokenSource();
    const linked = token.onCancellationRequested(() => cts.cancel());
    let stoppedByUs = false;
    const stopEarly = () => {
      stoppedByUs = true;
      cts.cancel();
    };
    const deadline = setTimeout(stopEarly, SOFT_DEADLINE_MS);

    let acc = "";
    let failure: string | undefined;

    status.busy(model.name);
    try {
      // Reasoning only adds latency for completions.
      const response = model.sendText(
        [SYSTEM_PROMPT, userPrompt],
        { thinkingMode: "off" },
        cts.token,
      );
      for await (const part of response) {
        if (token.isCancellationRequested) break;
        acc += part;
        if (isEnough(acc)) {
          stopEarly();
          break;
        }
      }
    } catch (err) {
      // Hitting our own deadline is not a failure: what we have is good enough.
      if (!stoppedByUs && !token.isCancellationRequested) {
        failure = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(deadline);
      linked.dispose();
      cts.dispose();
    }

    if (failure) {
      log(`[suggestions] error after ${elapsed()}ms — ${failure}`);
      status.notice("$(warning) AI Free: suggestion failed", failure);
      return undefined;
    }

    if (token.isCancellationRequested) {
      log(`[suggestions] cancelled by editor after ${elapsed()}ms`);
      status.idle();
      return undefined;
    }

    const completion = limitLines(
      trimOverlap(prefix, stripCodeFences(acc)),
    ).replace(/\s+$/, "");

    if (!completion) {
      // Usually a model that went into reasoning and returned no text.
      log(
        `[suggestions] empty completion after ${elapsed()}ms model=${model.id} (raw ${acc.length} chars)`,
      );
      status.notice(
        "$(circle-slash) AI Free: no suggestion",
        `${model.name} returned nothing usable`,
      );
      return undefined;
    }

    log(
      `[suggestions] model=${model.id} lang=${document.languageId} chars=${completion.length} in ${elapsed()}ms${stoppedByUs ? " (stopped early)" : ""}`,
    );
    status.idle();

    return [
      new vscode.InlineCompletionItem(
        completion,
        new vscode.Range(position, position),
      ),
    ];
  }
}

export function registerInlineCompletions(
  context: vscode.ExtensionContext,
): void {
  const status = new SuggestionStatus();

  context.subscriptions.push(
    status,
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new FreeAIInlineCompletionProvider(status),
    ),
    // Manual trigger command — proxies to the built-in inline suggest trigger.
    vscode.commands.registerCommand(
      `${VENDOR}.triggerInlineSuggestion`,
      async () => {
        const config = vscode.workspace.getConfiguration("freeAI.suggestions");
        if (!config.get("enabled", false)) {
          const action = await vscode.window.showInformationMessage(
            "Inline suggestions are disabled. Enable?",
            "Enable",
          );
          if (action !== "Enable") return;
          await config.update(
            "enabled",
            true,
            vscode.ConfigurationTarget.Global,
          );
        }
        await vscode.commands.executeCommand(
          "editor.action.inlineSuggest.trigger",
        );
      },
    ),
    vscode.commands.registerCommand(`${VENDOR}.selectSuggestionsModel`, () =>
      selectFeatureModel(SUGGESTIONS_FEATURE),
    ),
  );
}

function boundedNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
  min: number,
): number {
  const raw = Number(config.get(key, fallback));
  return Number.isFinite(raw) ? Math.max(min, Math.floor(raw)) : fallback;
}

/**
 * Models often repeat the text already typed before the cursor
 * (prefix `const x = ` → completion `const x = 5`). Cut the longest overlap.
 */
function trimOverlap(prefix: string, completion: string): string {
  const maxK = Math.min(prefix.length, completion.length, 200);
  for (let k = maxK; k > 0; k--) {
    if (prefix.endsWith(completion.slice(0, k))) return completion.slice(k);
  }
  return completion;
}

function isEnough(text: string): boolean {
  if (text.length >= MAX_COMPLETION_CHARS) return true;
  let lines = 1;
  for (const ch of text) {
    if (ch === "\n" && ++lines > MAX_COMPLETION_LINES) return true;
  }
  return false;
}

/** Stopping early cuts mid-line, so trim to whole lines here. */
function limitLines(text: string): string {
  const lines = text.split("\n");
  const limited =
    lines.length > MAX_COMPLETION_LINES
      ? lines.slice(0, MAX_COMPLETION_LINES).join("\n")
      : text;
  return limited.slice(0, MAX_COMPLETION_CHARS);
}
