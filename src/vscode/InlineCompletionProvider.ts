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

interface SuggestionConfig {
  enabled: boolean;
  maxPrefixChars: number;
  maxSuffixChars: number;
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

class FreeAIInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
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

    let acc = "";
    try {
      const response = await model.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
          vscode.LanguageModelChatMessage.User(userPrompt),
        ],
        // Reasoning не нужен для подсказок — только добавляет задержку.
        { modelOptions: { thinkingMode: "off" } },
        token,
      );

      for await (const part of response.text) {
        if (token.isCancellationRequested) {
          return undefined;
        }
        acc += part;
      }
    } catch (err) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log(`[suggestions] generation error: ${msg}`);
      return undefined;
    }

    const completion = trimOverlap(prefix, stripCodeFences(acc)).replace(
      /\s+$/,
      "",
    );
    if (!completion) {
      return undefined;
    }

    log(
      `[suggestions] model=${model.id} lang=${document.languageId} chars=${completion.length}`,
    );

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
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new FreeAIInlineCompletionProvider(),
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
