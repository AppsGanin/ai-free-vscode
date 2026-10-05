import * as os from "os";
import * as vscode from "vscode";
import { isDebugEnabled, log, recentLog, redact } from "../logger";
import type { UnifiedProvider } from "../providers/UnifiedProvider";

const ISSUES_URL = "https://github.com/AppsGanin/ai-free-vscode/issues/new";

/** Settings that change how requests go out; values are redacted on print. */
const REPORTED_SETTINGS = [
  "freeAI.debug",
  "freeAI.proxy",
  "freeAI.qwen.browserMode",
  "freeAI.zai.browserMode",
  "freeAI.playwright.timeout",
  "http.proxy",
  "http.proxySupport",
  "http.noProxy",
];

/** Where this copy runs: versions, platform, the settings that matter. */
export function environmentLines(context: vscode.ExtensionContext): string[] {
  const version = (context.extension.packageJSON as { version?: string }).version ?? "?";
  const lines = [
    `extension: ${context.extension.id} ${version} (${context.extensionMode === vscode.ExtensionMode.Development ? "development host" : "installed"})`,
    `editor: ${vscode.env.appName} ${vscode.version} · ui=${vscode.UIKind[vscode.env.uiKind] ?? vscode.env.uiKind}${vscode.env.remoteName ? ` · remote=${vscode.env.remoteName}` : ""} · lang=${vscode.env.language}`,
    `os: ${process.platform} ${os.release()} ${process.arch} · node ${process.versions.node}${process.versions.electron ? ` · electron ${process.versions.electron}` : ""}`,
    `playwright: ${playwrightVersion()}`,
  ];
  for (const key of REPORTED_SETTINGS) {
    const dot = key.indexOf(".");
    const value = vscode.workspace
      .getConfiguration(key.slice(0, dot))
      .get<unknown>(key.slice(dot + 1));
    if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
    lines.push(`setting ${key}: ${redact(JSON.stringify(value))}`);
  }
  return lines;
}

/** Per-provider sign-in state, never the session itself. */
async function providerLines(
  provider: UnifiedProvider,
  secrets: vscode.SecretStorage,
): Promise<string[]> {
  try {
    const states = await provider.getProviderAuthStates(secrets);
    return states.map(
      (s) => `provider ${s.name}${s.custom ? " (custom)" : ""}: ${s.authenticated ? "signed in" : "signed out"}`,
    );
  } catch (err) {
    return [`providers: could not read sign-in state (${String(err)})`];
  }
}

/** Logged once on activation, so every pasted log starts with the setup. */
export async function logEnvironment(
  context: vscode.ExtensionContext,
  provider: UnifiedProvider,
): Promise<void> {
  for (const line of environmentLines(context)) log(`[env] ${line}`);
  for (const line of await providerLines(provider, context.secrets)) log(`[env] ${line}`);
}

/** The text a user pastes into an issue: setup, then the recent log. */
export async function buildDebugReport(
  context: vscode.ExtensionContext,
  provider: UnifiedProvider,
): Promise<string> {
  const lines = recentLog();
  return [
    "### Environment",
    "```",
    ...environmentLines(context),
    ...(await providerLines(provider, context.secrets)),
    "```",
    "",
    `### Log (last ${lines.length} lines${isDebugEnabled() ? "" : ", verbose logs were OFF"})`,
    "```",
    ...lines,
    "```",
    "",
  ].join("\n");
}

export function registerDebugReport(
  context: vscode.ExtensionContext,
  provider: UnifiedProvider,
  channel: vscode.OutputChannel,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(`${provider.id}.copyDebugReport`, async () => {
      // Without verbose logs the report says what failed but rarely why.
      if (!isDebugEnabled()) {
        const choice = await vscode.window.showWarningMessage(
          "Verbose debug logs are off, so the report will have little detail. Turn them on, reproduce the problem, then copy the report again.",
          "Turn On Verbose Logs",
          "Copy Anyway",
        );
        if (choice === "Turn On Verbose Logs") {
          await vscode.workspace
            .getConfiguration("freeAI")
            .update("debug", true, vscode.ConfigurationTarget.Global);
          log("[extension] verbose debug logs turned on from the debug report");
          return;
        }
        if (choice !== "Copy Anyway") return;
      }

      await vscode.env.clipboard.writeText(await buildDebugReport(context, provider));
      const choice = await vscode.window.showInformationMessage(
        "Debug report copied. Tokens, cookies and e-mails are masked — still, skim it before posting. Paste it into a GitHub issue together with what you did and what happened.",
        "Open New Issue",
        "Show Log",
      );
      if (choice === "Open New Issue") {
        await vscode.env.openExternal(vscode.Uri.parse(ISSUES_URL));
      } else if (choice === "Show Log") {
        channel.show(true);
      }
    }),
  );
}

function playwrightVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require("playwright/package.json") as { version: string }).version;
  } catch {
    return "?";
  }
}
