import * as child_process from "child_process";
import * as fs from "fs";
import { chromium } from "playwright";
import * as vscode from "vscode";

/**
 * Убеждается, что встроенный Chromium установлен.
 * Если нет — запускает `playwright install chromium` с прогресс-уведомлением.
 * Вызывать перед launchPersistentContext без channel:'chrome'.
 */
export async function ensureChromium(): Promise<void> {
  let execPath: string | undefined;

  try {
    execPath = chromium.executablePath();
  } catch {
    // не удалось получить путь — всё равно попробуем установить
  }

  if (execPath && fs.existsSync(execPath)) {
    return; // уже установлен
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "AI Free VSCode: Устанавливаю Chromium (первый запуск)…",
      cancellable: false,
    },
    () =>
      new Promise<void>((resolve, reject) => {
        let playwrightCli: string;
        try {
          playwrightCli = require.resolve("playwright/cli");
        } catch {
          // если resolve не сработал — пробуем через внутренний путь
          playwrightCli = require.resolve("playwright/lib/cli/cli");
        }

        const proc = child_process.spawn(
          process.execPath,
          [playwrightCli, "install", "chromium"],
          { stdio: "pipe" },
        );

        proc.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `playwright install chromium завершился с кодом ${code}`,
              ),
            );
          }
        });

        proc.on("error", reject);
      }),
  );
}
