import * as vscode from "vscode";
import { createLogger } from "../../logger";
import {
  invalidateMimoCliCache,
  listCliModelRoutes,
  resolveMimoBinary,
  runInTerminal,
} from "./MimoCli";
import { findModelIdByRoute } from "./MimoModels";

const alog = createLogger("mimo-auth");

const NPM_INSTALL = "npm install -g @mimo-ai/cli";
const SCRIPT_INSTALL = "curl -fsSL https://mimo.xiaomi.com/install | bash";
const PS_INSTALL =
  'powershell -ep Bypass -c "irm https://mimo.xiaomi.com/install.ps1 | iex"';

/**
 * There is no sign-in: only the free anonymous MiMo Auto channel is used and no
 * key or token is stored at all. "Authentication" boils down to one question —
 * is the CLI installed and does it offer the model.
 */
export class MimoAuthManager {
  /**
   * Last logged model list. VS Code asks about auth from several places at once
   * (chat provider, command availability, status), which logged the same line
   * four times in a row.
   */
  private lastLoggedIds?: string;

  /** Our model ids actually available to the current CLI installation. */
  async availableModelIds(force = false): Promise<string[]> {
    const ids: string[] = [];
    for (const route of await listCliModelRoutes(force)) {
      const id = findModelIdByRoute(route);
      if (id && !ids.includes(id)) ids.push(id);
    }

    const joined = ids.join(", ") || "(none)";
    if (joined !== this.lastLoggedIds) {
      this.lastLoggedIds = joined;
      alog.debug(`models exposed to VS Code: ${joined}`);
    }
    return ids;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.availableModelIds()).length > 0;
  }

  /** Not a sign-in but an install: the free channel works right after it. */
  async login(): Promise<void> {
    invalidateMimoCliCache();
    const bin = await resolveMimoBinary();
    if (!bin) {
      await this.offerInstall();
      return;
    }

    const models = await this.availableModelIds(true);
    if (models.length > 0) {
      alog.info(`ready: ${models.join(", ")}`);
      vscode.window.showInformationMessage(
        "MiMo Code CLI is ready — no sign-in needed, the free MiMo Auto model is available in Copilot Chat.",
      );
      return;
    }

    // CLI present but offering nothing — usually its first-run wizard is unfinished.
    alog.warn("CLI found but MiMo Auto is not available");
    runInTerminal("MiMo Code — Setup", `"${bin}"`);
    vscode.window.showInformationMessage(
      "MiMo Code CLI reports no free model. Finish its first-run setup in the opened terminal (choose MiMo Auto), then run “AI Free VSCode — Status”.",
    );
  }

  /** Nothing to sign out of; just forget the cached CLI state. */
  async logout(): Promise<void> {
    invalidateMimoCliCache();
    alog.info("logout: nothing to revoke (anonymous free channel)");
    vscode.window.showInformationMessage(
      "MiMo Auto is anonymous — there is no session to sign out of. Uninstall the CLI (`mimo uninstall`) to remove it completely.",
    );
  }

  private async offerInstall(): Promise<void> {
    const scriptInstall =
      process.platform === "win32" ? PS_INSTALL : SCRIPT_INSTALL;

    const selected = await vscode.window.showQuickPick(
      [
        { label: "Install via npm", detail: NPM_INSTALL, command: NPM_INSTALL },
        {
          label: "Install via official script",
          detail: scriptInstall,
          command: scriptInstall,
        },
        {
          label: "Already installed — set the path",
          detail: "Opens the freeAI.mimo.path setting",
          command: "",
        },
      ],
      {
        title: "MiMo Code CLI is not installed",
        placeHolder:
          "The provider runs through the mimo CLI (no API key, no sign-in)",
        ignoreFocusOut: true,
      },
    );
    if (!selected) return;

    if (!selected.command) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "freeAI.mimo.path",
      );
      return;
    }

    alog.info(`install: ${selected.command}`);
    // Install, then `mimo` itself — its wizard finishes the free channel setup.
    runInTerminal("MiMo Code — Install", selected.command, "mimo");
    vscode.window.showInformationMessage(
      "Installing MiMo Code CLI in the terminal. When it finishes, run “AI Free VSCode — Status”.",
    );
  }
}
