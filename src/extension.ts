import * as vscode from "vscode";
import { log, setOutputChannel } from "./logger";
import { UnifiedProvider } from "./providers/UnifiedProvider";
import { DeepSeekProvider } from "./providers/deepseek/DeepSeekProvider";
import { QwenProvider } from "./providers/qwen/QwenProvider";
import { AuthExpiredError, RateLimitError } from "./providers/types";
import { ProviderRegistry } from "./vscode/ProviderRegistry";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("AI Free VSCode");
  context.subscriptions.push(channel);
  setOutputChannel(channel);
  log("[extension] activated");

  const registry = new ProviderRegistry(context.secrets);
  context.subscriptions.push(registry);

  // ─── Регистрируем провайдеры ─────────────────────────────────────────────
  // Единый провайдер для общего списка моделей в VS Code model picker.
  const qwenProvider = new QwenProvider();
  const deepSeekProvider = new DeepSeekProvider();
  const unifiedProvider = new UnifiedProvider([qwenProvider, deepSeekProvider]);
  registry.register(unifiedProvider);

  // ─── Слушаем ошибки авторизации от провайдеров ────────────────────────────
  for (const [id, provider] of registry.getAll()) {
    context.subscriptions.push(
      provider.onDidAuthChange(async () => {
        const isAuth = await provider.isAuthenticated(context.secrets);
        // Обновляем контекст команд (для when-условий в package.json)
        await vscode.commands.executeCommand(
          "setContext",
          `${id}.authenticated`,
          isAuth,
        );
      }),
    );
  }

  // ─── Динамическая регистрация команд для каждого провайдера ──────────────
  for (const [id, provider] of registry.getAll()) {
    // Login
    context.subscriptions.push(
      vscode.commands.registerCommand(`${id}.login`, async () => {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `${provider.displayName}: открываем браузер для авторизации...`,
            cancellable: false,
          },
          async () => {
            try {
              log(`[${id}] login started`);
              await provider.login(context.secrets);
              log(`[${id}] login success`);
              vscode.window.showInformationMessage(
                `${provider.displayName}: авторизация прошла успешно!`,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log(`[${id}] login error: ${message}`);
              if (err instanceof Error && err.stack) {
                log(err.stack);
              }
              vscode.window.showErrorMessage(
                `${provider.displayName}: ошибка авторизации — ${message}`,
              );
            }
          },
        );
      }),
    );

    // Logout
    context.subscriptions.push(
      vscode.commands.registerCommand(`${id}.logout`, async () => {
        const confirm = await vscode.window.showWarningMessage(
          `Выйти из ${provider.displayName}? Модели станут недоступны.`,
          { modal: true },
          "Выйти",
        );
        if (confirm === "Выйти") {
          await provider.logout(context.secrets);
          log(`[${id}] logged out`);
          vscode.window.showInformationMessage(
            `${provider.displayName}: вы вышли из аккаунта.`,
          );
        }
      }),
    );

    // Status
    context.subscriptions.push(
      vscode.commands.registerCommand(`${id}.status`, async () => {
        const isAuth = await provider.isAuthenticated(context.secrets);
        if (isAuth) {
          vscode.window.showInformationMessage(
            `${provider.displayName}: авторизован ✓. Модели доступны в Copilot Chat.`,
          );
        } else {
          const action = await vscode.window.showWarningMessage(
            `${provider.displayName}: не авторизован. Войдите, чтобы использовать модели.`,
            "Войти",
          );
          if (action === "Войти") {
            await vscode.commands.executeCommand(`${id}.login`);
          }
        }
      }),
    );

    // Manage (alias → status)
    context.subscriptions.push(
      vscode.commands.registerCommand(`${id}.manage`, () => {
        vscode.commands.executeCommand(`${id}.status`);
      }),
    );
  }

  // ─── Инициализация: проверяем начальное состояние авторизации ─────────────
  void initAuthStates(registry, context.secrets);
}

export function deactivate(): void {
  // Cleanup выполняется через context.subscriptions
}

async function initAuthStates(
  registry: ProviderRegistry,
  secrets: vscode.SecretStorage,
): Promise<void> {
  for (const [id, provider] of registry.getAll()) {
    const isAuth = await provider.isAuthenticated(secrets);
    await vscode.commands.executeCommand(
      "setContext",
      `${id}.authenticated`,
      isAuth,
    );

    if (!isAuth) {
      // Показываем ненавязчивое уведомление при первом запуске
      const action = await vscode.window.showInformationMessage(
        `${provider.displayName}: нажмите "Войти", чтобы использовать модели в Copilot Chat.`,
        "Войти",
        "Позже",
      );
      if (action === "Войти") {
        await vscode.commands.executeCommand(`${id}.login`);
      }
    }
  }
}

/**
 * Глобальный обработчик ошибок провайдера для использования в других местах.
 * Показывает уведомление с кнопкой "Войти" при AuthExpiredError.
 */
export async function handleProviderError(
  err: unknown,
  providerId: string,
): Promise<void> {
  if (err instanceof AuthExpiredError) {
    const action = await vscode.window.showWarningMessage(
      `Сессия истекла. Войдите снова в ${providerId}.`,
      "Войти",
    );
    if (action === "Войти") {
      await vscode.commands.executeCommand(`${providerId}.login`);
    }
  } else if (err instanceof RateLimitError) {
    const retryMin = err.retryAfterMs
      ? Math.ceil(err.retryAfterMs / 60000)
      : undefined;
    const msg = retryMin
      ? `Превышен лимит запросов. Попробуйте через ${retryMin} мин.`
      : "Превышен лимит запросов. Попробуйте позже.";
    vscode.window.showWarningMessage(msg);
  } else if (err instanceof Error) {
    vscode.window.showErrorMessage(`Ошибка ${providerId}: ${err.message}`);
  }
}
