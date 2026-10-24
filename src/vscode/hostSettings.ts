import * as vscode from "vscode";
import type { HostSettings } from "../providers/common/hostSettings";

/**
 * Provider settings from the VS Code configuration: `freeAI.proxy`, else VS
 * Code's own `http.proxy`, so Node requests (which go through VS Code's proxy
 * support) and the browsers leave the same way.
 */
export const vscodeHostSettings: HostSettings = {
  loginTimeoutMs: () =>
    vscode.workspace
      .getConfiguration("freeAI")
      .get<number>("playwright.timeout", 120000),
  proxy: () => {
    const own = vscode.workspace
      .getConfiguration("freeAI")
      .get<string>("proxy", "")
      .trim();
    return own || vscode.workspace.getConfiguration("http").get<string>("proxy", "").trim();
  },
  noProxy: () =>
    vscode.workspace.getConfiguration("http").get<string[]>("noProxy", []) ?? [],
  onProxyChange: (listener) => {
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("freeAI.proxy") || event.affectsConfiguration("http.proxy")) {
        listener();
      }
    });
  },
};

/** `freeAI.debug`, read on every line so the toggle needs no reload. */
export const vscodeDebugSwitch = (): boolean =>
  vscode.workspace.getConfiguration("freeAI").get<boolean>("debug", false);
