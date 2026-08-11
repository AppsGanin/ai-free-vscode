import * as vscode from "vscode";
import { log } from "../logger";
import {
  FIX_FEATURE,
  resolveFeatureModel,
  selectFeatureModel,
} from "./ModelPicker";
import { VENDOR, promptSignIn, stripCodeFences } from "./util";

const FIX_COMMAND = `${VENDOR}.fixProblem`;
const CONTEXT_LINES = 30;
const PREVIEW_SCHEME = "ai-free-fix-preview";

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

/** Holds the proposed content for the diff preview. */
class FixPreviewContentProvider implements vscode.TextDocumentContentProvider {
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

class FixProblemActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!isEnabled() || context.diagnostics.length === 0) return [];

    const action = new vscode.CodeAction(
      "✨ Fix with AI Free",
      vscode.CodeActionKind.QuickFix,
    );
    action.diagnostics = [...context.diagnostics];
    action.command = {
      command: FIX_COMMAND,
      title: "Fix with AI Free",
      arguments: [document.uri, [...context.diagnostics]],
    };
    return [action];
  }
}

export function registerFixProblem(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider,
    ),
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**" },
      new FixProblemActionProvider(),
      { providedCodeActionKinds: FixProblemActionProvider.providedKinds },
    ),
    vscode.commands.registerCommand(
      FIX_COMMAND,
      (uriArg?: vscode.Uri, diagnosticsArg?: vscode.Diagnostic[]) =>
        fixProblem(uriArg, diagnosticsArg),
    ),
    vscode.commands.registerCommand(`${VENDOR}.selectFixModel`, () =>
      selectFeatureModel(FIX_FEATURE),
    ),
  );
}

function isEnabled(): boolean {
  return Boolean(
    vscode.workspace.getConfiguration("freeAI.fix").get("enabled", true),
  );
}

async function fixProblem(
  uriArg?: vscode.Uri,
  diagnosticsArg?: vscode.Diagnostic[],
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = uriArg ?? editor?.document.uri;
  if (!uri) return;

  const document =
    editor?.document.uri.toString() === uri.toString()
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
    await promptSignIn("No models available. Sign in to Qwen or DeepSeek.");
    return;
  }

  const targetRange = lineRangeOfDiagnostics(document, diagnostics);
  const userPrompt = buildPrompt(document, targetRange, diagnostics);

  const fixed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      // See CommitMessageGenerator: the backend may change mid-request.
      title: "Fixing problem…",
      cancellable: true,
    },
    async (_progress, token): Promise<string | undefined> => {
      let acc = "";
      try {
        const response = model.sendText(
          [SYSTEM_PROMPT, userPrompt],
          { thinkingMode: "off" },
          token,
        );
        for await (const part of response) {
          if (token.isCancellationRequested) return undefined;
          acc += part;
        }
      } catch (err) {
        if (token.isCancellationRequested) return undefined;
        const msg = err instanceof Error ? err.message : String(err);
        log(`[fix] generation error: ${msg}`);
        vscode.window.showErrorMessage(`Failed to fix: ${msg}`);
        return undefined;
      }

      if (token.isCancellationRequested) return undefined;
      return stripCodeFences(acc.trim()).replace(/\n+$/, "");
    },
  );

  if (!fixed) {
    if (fixed === "") {
      vscode.window.showWarningMessage("The model returned an empty result.");
    }
    return;
  }

  // The model usually drops the original indentation; the replaced range starts
  // at column 0, so re-apply the base indent of the first line.
  const result = reindentBlock(
    fixed,
    leadingWhitespace(document.lineAt(targetRange.start.line).text),
  );

  const original = document.getText();
  const proposed =
    original.slice(0, document.offsetAt(targetRange.start)) +
    result +
    original.slice(document.offsetAt(targetRange.end));

  const fileName = uri.path.split("/").pop() || "file";
  const previewUri = vscode.Uri.from({
    scheme: PREVIEW_SCHEME,
    path: `/Fix — ${fileName}`,
    query: String(previewCounter++),
  });
  previewProvider.set(previewUri, proposed);

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
    if (choice !== "Apply") return;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, targetRange, result);
    if (await vscode.workspace.applyEdit(edit)) {
      log(
        `[fix] applied model=${model.id} lang=${document.languageId} lines=${targetRange.start.line + 1}-${targetRange.end.line + 1}`,
      );
    } else {
      vscode.window.showErrorMessage("Failed to apply the fix.");
    }
  } finally {
    await closePreviewTab(previewUri);
    previewProvider.clear(previewUri);
  }
}

function collectDiagnostics(
  uri: vscode.Uri,
  passed: vscode.Diagnostic[] | undefined,
  editor: vscode.TextEditor | undefined,
): vscode.Diagnostic[] {
  if (passed && passed.length > 0) return passed;

  const all = vscode.languages.getDiagnostics(uri);
  // From the command palette: prefer diagnostics under the selection/cursor.
  const inSelection = editor
    ? all.filter((d) => !!d.range.intersection(editor.selection))
    : [];
  return inSelection.length > 0 ? inSelection : all;
}

/** Full lines spanning every diagnostic. */
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
  if (startLine > endLine) startLine = endLine = 0;

  return new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endLine).range.end,
  );
}

function buildPrompt(
  document: vscode.TextDocument,
  target: vscode.Range,
  diagnostics: readonly vscode.Diagnostic[],
): string {
  const textBetween = (
    fromLine: number,
    fromChar: number,
    toLine: number,
    toChar: number,
  ) =>
    document.getText(
      new vscode.Range(
        new vscode.Position(fromLine, fromChar),
        new vscode.Position(toLine, toChar),
      ),
    );

  const contextBefore =
    target.start.line > 0
      ? textBetween(
          Math.max(0, target.start.line - CONTEXT_LINES),
          0,
          target.start.line,
          0,
        )
      : "";
  const afterEnd = Math.min(
    document.lineCount - 1,
    target.end.line + CONTEXT_LINES,
  );
  const contextAfter =
    target.end.line < document.lineCount - 1
      ? textBetween(
          target.end.line + 1,
          0,
          afterEnd,
          document.lineAt(afterEnd).range.end.character,
        )
      : "";

  return [
    `Language: ${document.languageId}`,
    "",
    "Problems to fix:",
    diagnostics
      .map(
        (d) =>
          `- [${severityLabel(d.severity)}] line ${d.range.start.line + 1}: ${d.message}`,
      )
      .join("\n"),
    "",
    "=== CONTEXT BEFORE ===",
    contextBefore,
    "=== CODE TO FIX (return a replacement for exactly this block) ===",
    document.getText(target),
    "=== CONTEXT AFTER ===",
    contextAfter,
    "=== END ===",
  ].join("\n");
}

function severityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
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

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Re-indents a block: strips its common indent, then applies the base one. */
function reindentBlock(text: string, baseIndent: string): string {
  const lines = text.split("\n");
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim()) {
      minIndent = Math.min(minIndent, leadingWhitespace(line).length);
    }
  }
  if (!Number.isFinite(minIndent)) minIndent = 0;

  return lines
    .map((line) => (line.trim() ? baseIndent + line.slice(minIndent) : ""))
    .join("\n");
}

async function closePreviewTab(previewUri: vscode.Uri): Promise<void> {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (
        tab.input instanceof vscode.TabInputTextDiff &&
        tab.input.modified.toString() === previewUri.toString()
      ) {
        await vscode.window.tabGroups.close(tab);
        return;
      }
    }
  }
}
