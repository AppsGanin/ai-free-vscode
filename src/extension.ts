import * as vscode from "vscode";
import { log, setOutputChannel } from "./logger";
import type { BaseAIProvider } from "./providers/BaseAIProvider";
import { UnifiedProvider } from "./providers/UnifiedProvider";
import { DeepSeekProvider } from "./providers/deepseek/DeepSeekProvider";
import { KimiProvider } from "./providers/kimi/KimiProvider";
import { MimoProvider } from "./providers/mimo/MimoProvider";
import { ProviderKey, enabledProviders } from "./providers/providerConfig";
import { QwenProvider } from "./providers/qwen/QwenProvider";
import { registerCommitMessageCommands } from "./vscode/CommitMessageGenerator";
import { registerFixProblem } from "./vscode/FixProblemProvider";
import { registerInlineCompletions } from "./vscode/InlineCompletionProvider";
import { setFeatureBackend } from "./vscode/ModelPicker";
import { VSCodeLMAdapter } from "./vscode/VSCodeLMAdapter";

// Which sub-providers end up in the build is decided by esbuild
// (PROVIDER_<NAME>=false, see esbuild.js + providerConfig.ts). To add one,
// append a key here and in ALL_PROVIDERS.
const PROVIDER_FACTORIES: Record<ProviderKey, () => BaseAIProvider> = {
  qwen: () => new QwenProvider(),
  deepseek: () => new DeepSeekProvider(),
  kimi: () => new KimiProvider(),
  mimo: () => new MimoProvider(),
};

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("AI Free VSCode");
  context.subscriptions.push(channel);
  setOutputChannel(channel);
  log("[extension] activated");

  const subProviders = enabledProviders().map((key) =>
    PROVIDER_FACTORIES[key](),
  );
  log(
    `[extension] enabled providers: ${subProviders.map((p) => p.id).join(", ") || "(none)"}`,
  );

  // One provider fronts them all, so VS Code shows a single model list.
  const provider = new UnifiedProvider(subProviders);
  const adapter = new VSCodeLMAdapter(provider, context.secrets);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(provider.id, adapter),
    adapter,
    provider,
  );
  setFeatureBackend(provider, context.secrets);

  registerAccountCommands(context, provider);
  registerCommitMessageCommands(context);
  registerInlineCompletions(context);
  registerFixProblem(context);

  void promptIfSignedOut(provider, context.secrets);
}

export function deactivate(): void {
  // Cleanup runs through context.subscriptions.
}

function registerAccountCommands(
  context: vscode.ExtensionContext,
  provider: UnifiedProvider,
): void {
  const { id, displayName } = provider;
  const secrets = context.secrets;

  context.subscriptions.push(
    vscode.commands.registerCommand(`${id}.login`, () =>
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${displayName}: opening browser for sign-in...`,
          cancellable: false,
        },
        async () => {
          try {
            await provider.login(secrets);
            log(`[${id}] login success`);
            vscode.window.showInformationMessage(
              `${displayName}: signed in successfully!`,
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`[${id}] login error: ${message}`);
            vscode.window.showErrorMessage(
              `${displayName}: sign-in error — ${message}`,
            );
          }
        },
      ),
    ),

    vscode.commands.registerCommand(`${id}.logout`, async () => {
      const confirm = await vscode.window.showWarningMessage(
        `Sign out of ${displayName}? Its models will become unavailable.`,
        { modal: true },
        "Sign Out",
      );
      if (confirm !== "Sign Out") return;
      await provider.logout(secrets);
      log(`[${id}] logged out`);
      vscode.window.showInformationMessage(`${displayName}: signed out.`);
    }),

    // Per-sub-provider breakdown: a single "signed in ✓" would hide which of
    // them still needs a login.
    vscode.commands.registerCommand(`${id}.status`, async () => {
      const states = await provider.getProviderAuthStates(secrets);
      const action = await vscode.window.showInformationMessage(
        `${displayName} — sign-in status`,
        {
          modal: true,
          detail: states
            .map((s) => `${s.authenticated ? "✓" : "✗"} ${s.name}`)
            .join("\n"),
        },
        ...(states.some((s) => !s.authenticated) ? ["Sign In"] : []),
      );
      if (action === "Sign In") {
        await vscode.commands.executeCommand(`${id}.login`);
      }
    }),

    vscode.commands.registerCommand(`${id}.manage`, () =>
      vscode.commands.executeCommand(`${id}.status`),
    ),
  );
}

/** Unobtrusive first-run nudge when nothing is signed in yet. */
async function promptIfSignedOut(
  provider: BaseAIProvider,
  secrets: vscode.SecretStorage,
): Promise<void> {
  if (await provider.isAuthenticated(secrets)) return;

  const action = await vscode.window.showInformationMessage(
    `${provider.displayName}: click "Sign In" to use the models in Copilot Chat.`,
    "Sign In",
    "Later",
  );
  if (action === "Sign In") {
    await vscode.commands.executeCommand(`${provider.id}.login`);
  }
}
