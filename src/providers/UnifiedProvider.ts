import * as vscode from "vscode";
import { BaseAIProvider } from "./BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "./types";

export interface ProviderAuthState {
  id: string;
  name: string;
  authenticated: boolean;
}

/** Fronts every sub-provider as a single VS Code model provider. */
export class UnifiedProvider extends BaseAIProvider {
  readonly id = "free-ai-vscode";
  readonly displayName = "AI Free VSCode";

  private readonly modelToProvider = new Map<string, BaseAIProvider>();
  private readonly authDisposables: vscode.Disposable[] = [];

  constructor(private readonly providers: BaseAIProvider[]) {
    super();

    for (const provider of providers) {
      for (const model of provider.getModels()) {
        if (this.modelToProvider.has(model.id)) {
          throw new Error(`Model id collision: "${model.id}"`);
        }
        this.modelToProvider.set(model.id, provider);
      }
      this.authDisposables.push(
        provider.onDidAuthChange(() => this._onDidAuthChange.fire()),
      );
    }
  }

  getModels(): AIModelInfo[] {
    return this.collectModels(this.providers);
  }

  /**
   * Only models of sub-providers the user actually signed into. Otherwise the
   * model picker (and `auto` for the features) offers models that fail on use.
   */
  override async getAvailableModels(
    secrets: vscode.SecretStorage,
  ): Promise<AIModelInfo[]> {
    const authed: BaseAIProvider[] = [];
    for (const provider of this.providers) {
      if (await provider.isAuthenticated(secrets)) authed.push(provider);
    }
    return this.collectModels(authed);
  }

  /** Per-sub-provider sign-in state, for the status UI. */
  async getProviderAuthStates(
    secrets: vscode.SecretStorage,
  ): Promise<ProviderAuthState[]> {
    const states: ProviderAuthState[] = [];
    for (const provider of this.providers) {
      states.push({
        id: provider.id,
        name: providerTag(provider),
        authenticated: await provider.isAuthenticated(secrets),
      });
    }
    return states;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isAuthenticated(secrets)) return true;
    }
    return false;
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    await this.pickAndRun("Sign In", (p) => p.login(secrets));
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await this.pickAndRun("Sign Out", (p) => p.logout(secrets));
  }

  sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const provider = this.modelToProvider.get(params.model);
    if (!provider) {
      throw new Error(`Model is not registered: ${params.model}`);
    }
    return provider.sendMessageStream(params, secrets);
  }

  override dispose(): void {
    for (const d of this.authDisposables) d.dispose();
    this.authDisposables.length = 0;
    for (const provider of this.providers) provider.dispose();
    super.dispose();
  }

  private async pickAndRun(
    action: string,
    run: (provider: BaseAIProvider) => Promise<void>,
  ): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      this.providers.map((provider) => ({
        label: provider.displayName,
        description: provider.id,
        value: provider.id,
      })),
      {
        title: `Select a provider to ${action.toLowerCase()}`,
        placeHolder: action,
        ignoreFocusOut: true,
      },
    );
    if (!selected) return;

    const provider = this.providers.find((p) => p.id === selected.value);
    if (!provider) throw new Error(`Provider not found: ${selected.value}`);

    await run(provider);
    this._onDidAuthChange.fire();
  }

  private collectModels(providers: BaseAIProvider[]): AIModelInfo[] {
    const seen = new Set<string>();
    const all: AIModelInfo[] = [];

    for (const provider of providers) {
      const tag = providerTag(provider);
      for (const model of provider.getModels()) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        // The name is shown as-is (it is recognisable already); the provider
        // lives in `family`, which drives grouping and settings lookup.
        all.push({
          ...model,
          family: model.family.startsWith(`${tag}/`)
            ? model.family
            : `${tag}/${model.family}`,
        });
      }
    }

    return all;
  }
}

function providerTag(provider: BaseAIProvider): string {
  return (
    provider.displayName.replace(/\s*\(.*\)\s*$/g, "").trim() || provider.id
  );
}
