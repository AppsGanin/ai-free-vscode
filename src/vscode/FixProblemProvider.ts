import * as vscode from "vscode";
import { log } from "../logger";
import {
  FIX_FEATURE,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";

const VENDOR = "free-ai-vscode";
const FIX_COMMAND = `${VENDOR}.fixProblem`;
const CONTEXT_LINES = 30;
const PREVIEW_SCHEME = "ai-free-fix-preview";

// Хранит предложенное (исправленное) содержимое для diff-предпросмотра.
class FixPreviewContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly contents = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

const previewProvider = new FixPreviewContentProvider();
let previewCounter = 0;

const SYSTEM_PROMPT = [
  "You are fixing code problems reported by the IDE (red/yellow squiggles).",
  "You are given the problem diagnostics, the exact code block to fix, and surrounding context.",
  "Return ONLY the corrected replacement for the CODE TO FIX block.",
  "Rules:",
  "- The output must be a drop-in replacement for those exact lines.",
  "- Do NOT include the surrounding context lines.",
  "- Do NOT wrap the output in markdown fences or quotes.",
  "- Do NOT add explanations.",
  "- Preserve the existing indentation style.",
].join("\n");

function isEnabled(): boolean {
  return Boolean(
    vscode.workspace.getConfiguration("freeAI.fix").get("enabled", true),
  );
}

// Закрывает вкладку diff-предпросмотра по URI предложенного документа.
async function closePreviewTab(previewUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        input.modified.toString() === previewUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}

function stripCodeFences(text: string): string {
  let out = text.trim();
  const fenced = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    return fenced[1];
  }
  out = out.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  out = out.replace(/\n?```\s*$/, "");
  return out;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

// Модель часто возвращает блок без исходного отступа (или нормализует его).
// Заменяемый диапазон начинается с колонки 0, поэтому восстанавливаем отступ:
// убираем общий минимальный отступ ответа и добавляем базовый отступ исходной
// строки к каждой строке, сохраняя относительную вложенность.
function reindentBlock(text: string, baseIndent: string): string {
  const lines = text.split("\n");

  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    minIndent = Math.min(minIndent, leadingWhitespace(line).length);
  }
  if (!Number.isFinite(minIndent)) {
    minIndent = 0;
  }

  return lines
    .map((line) => (line.trim() ? baseIndent + line.slice(minIndent) : ""))
    .join("\n");
}

function severityLabel(sev: vscode.DiagnosticSeverity): string {
  switch (sev) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

// Полные строки, охватывающие все диагностики.
function lineRangeOfDiagnostics(
  document: vscode.TextDocument,
  diagnostics: readonly vscode.Diagnostic[],
): vscode.Range {
  let startLine = Number.MAX_SAFE_INTEGER;
  let endLine = 0;
  for (const d of diagnostics) {
    startLine = Math.min(startLine, d.range.start.line);
    endLine = Math.max(endLine, d.range.end.line);
  }
  if (startLine > endLine) {
    startLine = endLine = 0;
  }
  return new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endLine).range.end,
  );
}

class FixProblemActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    _document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!isEnabled() || context.diagnostics.length === 0) {
      return [];
    }

    const action = new vscode.CodeAction(
      "✨ Fix with AI Free",
      vscode.CodeActionKind.QuickFix,
    );
    action.diagnostics = [...context.diagnostics];
    action.command = {
      command: FIX_COMMAND,
      title: "Fix with AI Free",
      arguments: [_document.uri, [...context.diagnostics]],
    };
    return [action];
  }
}

function collectDiagnostics(
  uri: vscode.Uri,
  passed: vscode.Diagnostic[] | undefined,
  editor: vscode.TextEditor | undefined,
): vscode.Diagnostic[] {
  if (passed && passed.length > 0) {
    return passed;
  }

  const all = vscode.languages.getDiagnostics(uri);
  if (all.length === 0) {
    return [];
  }

  // Из палитры команд: берём диагностики, пересекающие выделение/строку курсора;
  // если таких нет — все по файлу.
  if (editor) {
    const sel = editor.selection;
    const inSelection = all.filter((d) => !!d.range.intersection(sel));
    if (inSelection.length > 0) {
      return inSelection;
    }
  }
  return all;
}

async function fixProblem(
  uriArg?: vscode.Uri,
  diagnosticsArg?: vscode.Diagnostic[],
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = uriArg ?? editor?.document.uri;
  if (!uri) {
    return;
  }

  const document = editor?.document.uri.toString() === uri.toString()
    ? editor.document
    : await vscode.workspace.openTextDocument(uri);

  const diagnostics = collectDiagnostics(uri, diagnosticsArg, editor);
  if (diagnostics.length === 0) {
    vscode.window.showInformationMessage(
      "No problems (errors/warnings) to fix.",
    );
    return;
  }

  const model = await resolveFeatureModel(FIX_FEATURE);
  if (!model) {
    const action = await vscode.window.showWarningMessage(
      "No models available. Sign in to Qwen or DeepSeek.",
      "Sign In",
    );
    if (action === "Sign In") {
      await vscode.commands.executeCommand(`${VENDOR}.login`);
    }
    return;
  }

  const targetRange = lineRangeOfDiagnostics(document, diagnostics);
  const codeToFix = document.getText(targetRange);

  const beforeStart = Math.max(0, targetRange.start.line - CONTEXT_LINES);
  const afterEnd = Math.min(
    document.lineCount - 1,
    targetRange.end.line + CONTEXT_LINES,
  );
  const contextBefore =
    targetRange.start.line > 0
      ? document.getText(
          new vscode.Range(
            new vscode.Position(beforeStart, 0),
            new vscode.Position(targetRange.start.line, 0),
          ),
        )
      : "";
  const contextAfter =
    targetRange.end.line < document.lineCount - 1
      ? document.getText(
          new vscode.Range(
            new vscode.Position(targetRange.end.line + 1, 0),
            document.lineAt(afterEnd).range.end,
          ),
        )
      : "";

  const problems = diagnostics
    .map(
      (d) =>
        `- [${severityLabel(d.severity)}] line ${d.range.start.line + 1}: ${d.message}`,
    )
    .join("\n");

  const userPrompt = [
    `Language: ${document.languageId}`,
    "",
    "Problems to fix:",
    problems,
    "",
    "=== CONTEXT BEFORE ===",
    contextBefore,
    "=== CODE TO FIX (return a replacement for exactly this block) ===",
    codeToFix,
    "=== CONTEXT AFTER ===",
    contextAfter,
    "=== END ===",
  ].join("\n");

  // Генерация исправления — под прогресс-индикатором.
  const fixed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Fixing problem (${model.name})…`,
      cancellable: true,
    },
    async (_progress, token): Promise<string | undefined> => {
      let acc = "";
      try {
        const response = await model.sendRequest(
          [
            vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
            vscode.LanguageModelChatMessage.User(userPrompt),
          ],
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
        log(`[fix] generation error: ${msg}`);
        vscode.window.showErrorMessage(`Failed to fix: ${msg}`);
        return undefined;
      }

      if (token.isCancellationRequested) {
        return undefined;
      }

      return stripCodeFences(acc).replace(/\n+$/, "");
    },
  );

  if (!fixed) {
    if (fixed === "") {
      vscode.window.showWarningMessage("The model returned an empty result.");
    }
    return;
  }

  // Восстанавливаем отступ исходной строки — модель часто его теряет.
  const baseIndent = leadingWhitespace(
    document.lineAt(targetRange.start.line).text,
  );
  const result = reindentBlock(fixed, baseIndent);

  const apply = async (): Promise<void> => {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, targetRange, result);
    const applied = await vscode.workspace.applyEdit(edit);
    if (applied) {
      log(
        `[fix] applied model=${model.id} lang=${document.languageId} lines=${targetRange.start.line + 1}-${targetRange.end.line + 1}`,
      );
    } else {
      vscode.window.showErrorMessage("Failed to apply the fix.");
    }
  };

  // Предпросмотр: формируем полный предложенный текст и показываем diff.
  const original = document.getText();
  const startOffset = document.offsetAt(targetRange.start);
  const endOffset = document.offsetAt(targetRange.end);
  const proposedFull =
    original.slice(0, startOffset) + result + original.slice(endOffset);

  const fileName = uri.path.split("/").pop() || "file";
  const previewUri = vscode.Uri.from({
    scheme: PREVIEW_SCHEME,
    path: `/Fix — ${fileName}`,
    query: String(previewCounter++),
  });
  previewProvider.set(previewUri, proposedFull);

  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      uri,
      previewUri,
      `AI Free: fix ${fileName} (preview)`,
      { preview: true },
    );

    const choice = await vscode.window.showInformationMessage(
      "Apply the proposed fix?",
      { modal: false },
      "Apply",
      "Cancel",
    );

    if (choice === "Apply") {
      await apply();
    }
  } finally {
    await closePreviewTab(previewUri);
    previewProvider.clear(previewUri);
  }
}

export function registerFixProblem(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider,
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**" },
      new FixProblemActionProvider(),
      { providedCodeActionKinds: FixProblemActionProvider.providedKinds },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      FIX_COMMAND,
      (uriArg?: vscode.Uri, diagnosticsArg?: vscode.Diagnostic[]) =>
        fixProblem(uriArg, diagnosticsArg),
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(`${VENDOR}.selectFixModel`, () =>
      selectFeatureModel(FIX_FEATURE),
    ),
  );
}
