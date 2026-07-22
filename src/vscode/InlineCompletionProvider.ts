import * as vscode from "vscode";
import { log } from "../logger";
import {
  SUGGESTIONS_FEATURE,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";

const VENDOR = "free-ai-vscode";

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

/** По истечении срока не ждём дальше, а отдаём накопленное. */
const SOFT_DEADLINE_MS = 30000;
const MAX_COMPLETION_CHARS = 600;
const MAX_COMPLETION_LINES = 12;
const STATUS_NOTICE_MS = 2500;

interface SuggestionConfig {
  enabled: boolean;
  maxPrefixChars: number;
  maxSuffixChars: number;
}

/** Индикатор: без него провал подсказки неотличим от «ничего не нажалось». */
class SuggestionStatus {
  private readonly item: vscode.StatusBarItem;
  private noticeTimer?: NodeJS.Timeout;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
  }

  busy(modelName: string): void {
    this.clearNotice();
    this.item.text = "$(sync~spin) AI Free: suggesting…";
    this.item.tooltip = `Inline suggestion from ${modelName}`;
    this.item.command = undefined;
    this.item.show();
  }

  /** Кликабельно: ведёт в выбор модели — обычно дело в ней. */
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

function readConfig(): SuggestionConfig {
  const cfg = vscode.workspace.getConfiguration("freeAI.suggestions");

  const maxPrefixRaw = Number(cfg.get("maxPrefixChars", 2000));
  const maxPrefixChars = Number.isFinite(maxPrefixRaw)
    ? Math.max(200, Math.floor(maxPrefixRaw))
    : 2000;

  const maxSuffixRaw = Number(cfg.get("maxSuffixChars", 800));
  const maxSuffixChars = Number.isFinite(maxSuffixRaw)
    ? Math.max(0, Math.floor(maxSuffixRaw))
    : 800;

  return {
    enabled: Boolean(cfg.get("enabled", false)),
    maxPrefixChars,
    maxSuffixChars,
  };
}

function stripCodeFences(text: string): string {
  let out = text;
  // Полный fenced-блок ```lang\n...\n```
  const fenced = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    return fenced[1];
  }
  // Висячие ограждения, если модель не закрыла блок.
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  out = out.replace(/\n?```\s*$/, "");
  return out;
}

// Модель часто повторяет уже набранный хвост перед курсором
// (например prefix "const x = " → completion "const x = 5").
// Срезаем самое длинное перекрытие: суффикс prefix, совпадающий с началом completion.
function trimOverlap(prefix: string, completion: string): string {
  const maxK = Math.min(prefix.length, completion.length, 200);
  for (let k = maxK; k > 0; k--) {
    if (prefix.endsWith(completion.slice(0, k))) {
      return completion.slice(k);
    }
  }
  return completion;
}

function isEnough(text: string): boolean {
  if (text.length >= MAX_COMPLETION_CHARS) {
    return true;
  }
  let lines = 1;
  for (const ch of text) {
    if (ch === "\n" && ++lines > MAX_COMPLETION_LINES) {
      return true;
    }
  }
  return false;
}

/** Ранняя остановка режет поток не по границе строки — дочищаем здесь. */
function limitLines(text: string): string {
  const lines = text.split("\n");
  const limited =
    lines.length > MAX_COMPLETION_LINES
      ? lines.slice(0, MAX_COMPLETION_LINES).join("\n")
      : text;
  return limited.length > MAX_COMPLETION_CHARS
    ? limited.slice(0, MAX_COMPLETION_CHARS)
    : limited;
}

class FreeAIInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  /** Номер последнего запроса: статус-бар слушается только его. */
  private seq = 0;

  constructor(private readonly status: SuggestionStatus) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = readConfig();
    if (!config.enabled) {
      return undefined;
    }

    // Только ручной вызов: на автоматический набор не реагируем, чтобы не
    // дёргать медленные веб-сессии на каждый символ.
    if (
      context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
    ) {
      return undefined;
    }

    const model = await resolveFeatureModel(SUGGESTIONS_FEATURE);
    if (!model || token.isCancellationRequested) {
      return undefined;
    }

    const offset = document.offsetAt(position);
    const fullText = document.getText();
    const prefix = fullText
      .slice(0, offset)
      .slice(-config.maxPrefixChars);
    const suffix = fullText
      .slice(offset)
      .slice(0, config.maxSuffixChars);

    if (!prefix.trim() && !suffix.trim()) {
      return undefined;
    }

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

    // Индикатор мог перехватить более свежий запрос — гасить его нельзя.
    const mine = ++this.seq;
    const status = {
      busy: (name: string) => mine === this.seq && this.status.busy(name),
      notice: (text: string, tip: string) =>
        mine === this.seq && this.status.notice(text, tip),
      idle: () => mine === this.seq && this.status.idle(),
    };

    // Свой токен поверх редакторского — чтобы обрывать генерацию самим.
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
      const response = model.sendText(
        [SYSTEM_PROMPT, userPrompt],
        // Reasoning не нужен для подсказок — только добавляет задержку.
        { thinkingMode: "off" },
        cts.token,
      );

      for await (const part of response) {
        if (token.isCancellationRequested) {
          break;
        }
        acc += part;
        if (isEnough(acc)) {
          stopEarly();
          break;
        }
      }
    } catch (err) {
      // Отмена по дедлайну — не ошибка: накопленное годится.
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
      log(
        `[suggestions] cancelled by editor after ${elapsed()}ms (received ${acc.length} chars)`,
      );
      status.idle();
      return undefined;
    }

    const completion = limitLines(
      trimOverlap(prefix, stripCodeFences(acc)),
    ).replace(/\s+$/, "");

    if (!completion) {
      // Чаще всего это модель, ушедшая в reasoning и не отдавшая текста.
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
  context.subscriptions.push(status);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new FreeAIInlineCompletionProvider(status),
    ),
  );

  // Команда ручного вызова — проксирует на встроенный триггер inline-подсказок.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${VENDOR}.triggerInlineSuggestion`,
      async () => {
        const cfg = vscode.workspace.getConfiguration("freeAI.suggestions");
        if (!cfg.get("enabled", false)) {
          const action = await vscode.window.showInformationMessage(
            "Inline suggestions are disabled. Enable?",
            "Enable",
          );
          if (action === "Enable") {
            await cfg.update(
              "enabled",
              true,
              vscode.ConfigurationTarget.Global,
            );
          } else {
            return;
          }
        }
        await vscode.commands.executeCommand(
          "editor.action.inlineSuggest.trigger",
        );
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${VENDOR}.selectSuggestionsModel`, () =>
      selectFeatureModel(SUGGESTIONS_FEATURE),
    ),
  );
}
