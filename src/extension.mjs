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
import {
  clearProfileSession,
  loginAndSaveAuth,
  readSavedAuth,
} from "./deepseek/auth.mjs";
import { AUTH_FILE } from "./deepseek/config.mjs";
import { registerLmProvider } from "./lmProvider.mjs";
import {
  clearProfileSession as clearQwenProfileSession,
  loginAndSaveAuth as loginAndSaveQwenAuth,
  AUTH_FILE as QWEN_AUTH_FILE,
  readSavedAuth as readSavedQwenAuth,
} from "./qwen/auth.mjs";
import { setDebugMode } from "./utils/logger.mjs";

/** @type {{ cookieHeader: string, token: string }} */
export const auth = { cookieHeader: "", token: "" };

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

  // Load saved DeepSeek auth (if any)
  try {
    const saved = readSavedAuth();
    if (saved) {
      auth.cookieHeader = saved.cookieHeader;
      auth.token = saved.token;
    }
  } catch (e) {
    console.warn(`DeepSeek: failed to read saved auth: ${e?.message || e}`);
  }

  // Load saved Qwen auth (if any)
  try {
    const savedQwen = readSavedQwenAuth();
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
        await clearProfileSession().catch(() => {});
        const result = await loginAndSaveAuth();
        auth.cookieHeader = result.cookieHeader;
        auth.token = result.token;
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
      auth.cookieHeader = "";
      auth.token = "";
      try {
        fs.rmSync(AUTH_FILE, { force: true });
      } catch {}
      vscode.window.showInformationMessage("DeepSeek: signed out.");
    }),
  );

  // Command: sign in to Qwen
  context.subscriptions.push(
    vscode.commands.registerCommand("qwen.login", async () => {
      try {
        await clearQwenProfileSession().catch(() => {});
        const result = await loginAndSaveQwenAuth();
        qwenAuth.token = result.token;
        vscode.window.showInformationMessage("Qwen: signed in successfully!");
      } catch (e) {
        vscode.window.showErrorMessage(`Qwen: sign-in failed — ${e.message}`);
      }
    }),
  );

  // Command: sign out of Qwen
  context.subscriptions.push(
    vscode.commands.registerCommand("qwen.logout", () => {
      qwenAuth.token = "";
      try {
        fs.rmSync(QWEN_AUTH_FILE, { force: true });
      } catch {}
      vscode.window.showInformationMessage("Qwen: signed out.");
    }),
  );

  // Initialize logger with debug setting from config
  const debugConfig = vscode.workspace
    .getConfiguration()
    .get("ai-free-vscode.debug");
  setDebugMode(debugConfig);

  // Register unified AI Free VSCode provider
  try {
    registerLmProvider(context, auth, qwenAuth);
  } catch (e) {
    console.warn(
      `AI Free VSCode: failed to register language model provider: ${e?.message || e}`,
    );
  }

  console.log("AI Free VSCode extension activated");
}

export function deactivate() {
  console.log("AI Free VSCode extension deactivated");
}
