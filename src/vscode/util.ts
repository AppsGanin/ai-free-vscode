import * as vscode from "vscode";

/** Command namespace; matches the vendor id in package.json. */
export const VENDOR = "free-ai-vscode";

/** Removes markdown fences the model wrapped its answer in. */
export function stripCodeFences(text: string): string {
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) return fenced[1];
  return text.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```\s*$/, "");
}

/** "No models" warning with a shortcut to the sign-in command. */
export async function promptSignIn(
  message = "No models available. Sign In to a provider to use AI Free.",
): Promise<void> {
  const action = await vscode.window.showWarningMessage(message, "Sign In");
  if (action === "Sign In") {
    await vscode.commands.executeCommand(`${VENDOR}.login`);
  }
}
