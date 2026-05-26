/**
 * VS Code Extension entry point.
 *
 * Loads provider auth and registers:
 *   - commands deepseek.login / deepseek.logout and qwen.login / qwen.logout (Playwright)
 *   - unified LM provider ai-free-vscode for language model settings
 */

import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { registerLmProvider } from "./providers/AiFreeProvider.mjs";
import { getProvider } from "./providers/index.mjs";
import {
  dispose as disposeLogger,
  info,
  initChannel,
  error as logError,
  setDebugMode,
  setLevelFilter,
  show as showLogs,
} from "./utils/logger.mjs";

/** @type {{ cookieHeader: string, token: string }} */
export const deepseekAuth = { cookieHeader: "", token: "" };

/** @type {{ token: string }} */
export const qwenAuth = { token: "" };

export async function activate(context) {
  // Point Playwright to the bundled Chromium (packed inside the .vsix).
  // Falls back to the global Playwright cache if the bundled copy is absent
  // (e.g. when the extension is loaded directly from source).
  const bundledBrowsersPath = path.join(
    context.extensionPath,
    "playwright-browsers",
  );
  if (fs.existsSync(bundledBrowsersPath)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsersPath;
  }

  // Load saved auth for all providers
  const deepseekProvider = getProvider("deepseek");
  const qwenProvider = getProvider("qwen");

  try {
    const savedDeepseek = deepseekProvider.loadAuth();
    if (savedDeepseek) {
      deepseekAuth.cookieHeader = savedDeepseek.cookieHeader;
      deepseekAuth.token = savedDeepseek.token;
    }
  } catch (e) {
    console.warn(`DeepSeek: failed to read saved auth: ${e?.message || e}`);
  }

  try {
    const savedQwen = qwenProvider.loadAuth();
    if (savedQwen) {
      qwenAuth.token = savedQwen.token;
    }
  } catch (e) {
    console.warn(`Qwen: failed to read saved auth: ${e?.message || e}`);
  }

  // Command: sign in via Playwright
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.login", async () => {
      try {
        await deepseekProvider.logout().catch(() => {});
        const result = await deepseekProvider.login();
        deepseekAuth.cookieHeader = result.auth.cookieHeader;
        deepseekAuth.token = result.auth.token;
        vscode.window.showInformationMessage(
          "DeepSeek: signed in successfully!",
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `DeepSeek: sign-in failed — ${e.message}`,
        );
      }
    }),
  );

  // Command: sign out of DeepSeek
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.logout", () => {
      deepseekProvider.logout();
      deepseekAuth.cookieHeader = "";
      deepseekAuth.token = "";
      vscode.window.showInformationMessage("DeepSeek: signed out.");
    }),
  );

  // Command: sign in to Qwen
  context.subscriptions.push(
    vscode.commands.registerCommand("qwen.login", async () => {
      try {
        await qwenProvider.logout().catch(() => {});
        const result = await qwenProvider.login();
        qwenAuth.token = result.auth.token;
        vscode.window.showInformationMessage("Qwen: signed in successfully!");
      } catch (e) {
        vscode.window.showErrorMessage(`Qwen: sign-in failed — ${e.message}`);
      }
    }),
  );

  // Command: sign out of Qwen
  context.subscriptions.push(
    vscode.commands.registerCommand("qwen.logout", () => {
      qwenProvider.logout();
      qwenAuth.token = "";
      vscode.window.showInformationMessage("Qwen: signed out.");
    }),
  );

  // Initialize logger — create Output Channel first so all subsequent logs go there
  const logChannel = vscode.window.createOutputChannel("AI Free VSCode");
  context.subscriptions.push(logChannel);
  initChannel(logChannel);

  // Initialize logger with debug setting from config
  const debugConfig = vscode.workspace
    .getConfiguration()
    .get("ai-free-vscode.debug");
  setDebugMode(debugConfig);

  // Optional log level filter from config (defaults to 'info' unless debug mode)
  const levelFilter = vscode.workspace
    .getConfiguration()
    .get("ai-free-vscode.logLevel");
  if (levelFilter) setLevelFilter(levelFilter);

  info("AI Free VSCode extension activating");

  // Status bar — shows which model is active during requests
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = "ai-free-vscode.showLogs";
  statusBar.tooltip = "AI Free VSCode — click to show logs";
  context.subscriptions.push(statusBar);

  // Command: show logs in Output panel
  context.subscriptions.push(
    vscode.commands.registerCommand("ai-free-vscode.showLogs", () => {
      showLogs();
    }),
  );

  // Register unified AI Free VSCode provider
  try {
    registerLmProvider(context, deepseekAuth, qwenAuth, statusBar);
  } catch (e) {
    logError(
      `AI Free VSCode: failed to register language model provider: ${e?.message || e}`,
    );
    vscode.window.showErrorMessage(
      'AI Free VSCode failed to activate. Run "AI Free VSCode: Show Logs" for details.',
    );
  }

  info("AI Free VSCode extension activated");
  console.log("AI Free VSCode extension activated");
}

export function deactivate() {
  info("AI Free VSCode extension deactivated");
  disposeLogger();
  console.log("AI Free VSCode extension deactivated");
}
