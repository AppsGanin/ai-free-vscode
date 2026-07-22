import * as vscode from "vscode";
import { log, setOutputChannel } from "./logger";
import { BaseAIProvider } from "./providers/BaseAIProvider";
import { UnifiedProvider } from "./providers/UnifiedProvider";
import { DeepSeekProvider } from "./providers/deepseek/DeepSeekProvider";
import { KimiProvider } from "./providers/kimi/KimiProvider";
import { MimoProvider } from "./providers/mimo/MimoProvider";
import { ProviderKey, enabledProviders } from "./providers/providerConfig";
import { QwenProvider } from "./providers/qwen/QwenProvider";
import { AuthExpiredError, RateLimitError } from "./providers/types";
import { registerCommitMessageCommands } from "./vscode/CommitMessageGenerator";
import { registerFixProblem } from "./vscode/FixProblemProvider";
import { registerInlineCompletions } from "./vscode/InlineCompletionProvider";
import { setFeatureBackend } from "./vscode/ModelPicker";
import { ProviderRegistry } from "./vscode/ProviderRegistry";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("AI Free VSCode");
  context.subscriptions.push(channel);
  setOutputChannel(channel);
  log("[extension] activated");

  const registry = new ProviderRegistry(context.secrets);
  context.subscriptions.push(registry);

  // ─── Регистрируем провайдеры ─────────────────────────────────────────────
  // Какие провайдеры попадают в сборку, решается на этапе сборки
  // (PROVIDER_<NAME>=false, см. esbuild.js + providerConfig.ts).
  // Чтобы добавить нового провайдера — допишите ключ сюда и в ALL_PROVIDERS.
  const providerFactories: Record<ProviderKey, () => BaseAIProvider> = {
    qwen: () => new QwenProvider(),
    deepseek: () => new DeepSeekProvider(),
    kimi: () => new KimiProvider(),
    mimo: () => new MimoProvider(),
  };

  const subProviders = enabledProviders().map((key) =>
    providerFactories[key](),
  );

  log(
    `[extension] enabled providers: ${
      subProviders.map((p) => p.id).join(", ") || "(none)"
    }`,
  );

  // Единый провайдер для общего списка моделей в VS Code model picker.
  const unifiedProvider = new UnifiedProvider(subProviders);
  registry.register(unifiedProvider);


  setFeatureBackend(unifiedProvider, context.secrets);

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
            title: `${provider.displayName}: opening browser for sign-in...`,
            cancellable: false,
          },
          async () => {
            try {
              log(`[${id}] login started`);
              await provider.login(context.secrets);
              log(`[${id}] login success`);
              vscode.window.showInformationMessage(
                `${provider.displayName}: signed in successfully!`,
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              log(`[${id}] login error: ${message}`);
              if (err instanceof Error && err.stack) {
                log(err.stack);
              }
              vscode.window.showErrorMessage(
                `${provider.displayName}: sign-in error — ${message}`,
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
          `Sign out of ${provider.displayName}? Its models will become unavailable.`,
          { modal: true },
          "Sign Out",
        );
        if (confirm === "Sign Out") {
          await provider.logout(context.secrets);
          log(`[${id}] logged out`);
          vscode.window.showInformationMessage(
            `${provider.displayName}: signed out.`,
          );
        }
      }),
    );

    // Status
    context.subscriptions.push(
      vscode.commands.registerCommand(`${id}.status`, async () => {
        // Для составного провайдера показываем разбивку по каждому под-провайдеру
        // (какой залогинен, а какой нет), а не общий «signed in ✓».
        if (provider instanceof UnifiedProvider) {
          const states = await provider.getProviderAuthStates(context.secrets);
          const lines = states
            .map((s) => `${s.authenticated ? "✓" : "✗"} ${s.name}`)
            .join("\n");
          const anyMissing = states.some((s) => !s.authenticated);

          const action = await vscode.window.showInformationMessage(
            `${provider.displayName} — sign-in status`,
            { modal: true, detail: lines },
            ...(anyMissing ? ["Sign In"] : []),
          );
          if (action === "Sign In") {
            await vscode.commands.executeCommand(`${id}.login`);
          }
          return;
        }

        const isAuth = await provider.isAuthenticated(context.secrets);
        if (isAuth) {
          vscode.window.showInformationMessage(
            `${provider.displayName}: signed in ✓. Models available in Copilot Chat.`,
          );
        } else {
          const action = await vscode.window.showWarningMessage(
            `${provider.displayName}: not signed in. Sign in to use the models.`,
            "Sign In",
          );
          if (action === "Sign In") {
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

  // ─── Кнопка генерации сообщения коммита (как у Copilot) ──────────────────
  registerCommitMessageCommands(context);

  // ─── Inline-подсказки (ghost text) ───────────────────────────────────────
  registerInlineCompletions(context);

  // ─── Исправление проблем (красное/жёлтое) через Quick Fix ────────────────
  registerFixProblem(context);

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
        `${provider.displayName}: click "Sign In" to use the models in Copilot Chat.`,
        "Sign In",
        "Later",
      );
      if (action === "Sign In") {
        await vscode.commands.executeCommand(`${id}.login`);
      }
    }
  }
}

/**
 * Глобальный обработчик ошибок провайдера для использования в других местах.
 * Показывает уведомление с кнопкой "Sign In" при AuthExpiredError.
 */
export async function handleProviderError(
  err: unknown,
  providerId: string,
): Promise<void> {
  if (err instanceof AuthExpiredError) {
    const action = await vscode.window.showWarningMessage(
      `Session expired. Sign in to ${providerId} again.`,
      "Sign In",
    );
    if (action === "Sign In") {
      await vscode.commands.executeCommand(`${providerId}.login`);
    }
  } else if (err instanceof RateLimitError) {
    const retryMin = err.retryAfterMs
      ? Math.ceil(err.retryAfterMs / 60000)
      : undefined;
    const msg = retryMin
      ? `Rate limit exceeded. Try again in ${retryMin} min.`
      : "Rate limit exceeded. Try again later.";
    vscode.window.showWarningMessage(msg);
  } else if (err instanceof Error) {
    vscode.window.showErrorMessage(`${providerId} error: ${err.message}`);
  }
}
