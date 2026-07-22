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
 * Входа здесь нет: используется только бесплатный анонимный канал MiMo Auto,
 * а ключей и токенов расширение не хранит вовсе. «Авторизация» сводится к
 * одному вопросу — установлен ли CLI и отдаёт ли он модель.
 */
export class MimoAuthManager {
  /**
   * Последний залогированный состав моделей. Проверку авторизации VS Code
   * спрашивает из нескольких мест сразу (провайдер чата, доступность команд,
   * статус), и без этого один и тот же список писался в лог по 4 раза подряд.
   */
  private lastLoggedIds?: string;

  /** Наши ID моделей, реально доступные текущей установке CLI. */
  async availableModelIds(force = false): Promise<string[]> {
    const routes = await listCliModelRoutes(force);
    const ids: string[] = [];
    for (const route of routes) {
      const id = findModelIdByRoute(route);
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
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

  /** Не вход, а установка CLI: бесплатный канал работает сразу после неё. */
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

    // CLI есть, но модели не отдаёт — обычно не пройден мастер первого запуска.
    alog.warn("CLI found but MiMo Auto is not available");
    runInTerminal("MiMo Code — Setup", `"${bin}"`);
    vscode.window.showInformationMessage(
      "MiMo Code CLI reports no free model. Finish its first-run setup in the opened terminal (choose MiMo Auto), then run “AI Free VSCode — Status”.",
    );
  }

  /** Выходить не из чего — просто забываем закэшированное состояние CLI. */
  async logout(): Promise<void> {
    invalidateMimoCliCache();
    alog.info("logout: nothing to revoke (anonymous free channel)");
    vscode.window.showInformationMessage(
      "MiMo Auto is anonymous — there is no session to sign out of. Uninstall the CLI (`mimo uninstall`) to remove it completely.",
    );
  }

  private async offerInstall(): Promise<void> {
    const isWindows = process.platform === "win32";
    const picks = [
      {
        label: "Install via npm",
        detail: NPM_INSTALL,
        command: NPM_INSTALL,
      },
      {
        label: "Install via official script",
        detail: isWindows ? PS_INSTALL : SCRIPT_INSTALL,
        command: isWindows ? PS_INSTALL : SCRIPT_INSTALL,
      },
      {
        label: "Already installed — set the path",
        detail: "Opens the freeAI.mimo.path setting",
        command: "",
      },
    ];

    const selected = await vscode.window.showQuickPick(picks, {
      title: "MiMo Code CLI is not installed",
      placeHolder: "The provider runs through the mimo CLI (no API key, no sign-in)",
      ignoreFocusOut: true,
    });
    if (!selected) {
      return;
    }

    if (!selected.command) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "freeAI.mimo.path",
      );
      return;
    }

    alog.info(`install: ${selected.command}`);
    // Установка и мастер первого запуска — двумя командами: `mimo` доводит
    // настройку бесплатного канала до конца.
    runInTerminal("MiMo Code — Install", selected.command, "mimo");
    vscode.window.showInformationMessage(
      "Installing MiMo Code CLI in the terminal. When it finishes, run “AI Free VSCode — Status”.",
    );
  }
}
