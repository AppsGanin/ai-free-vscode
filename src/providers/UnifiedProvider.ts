import * as vscode from "vscode";
import { log } from "../logger";
import { BaseAIProvider } from "./BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "./types";

export interface ProviderAuthState {
  id: string;
  name: string;
  authenticated: boolean;
  /** User-defined OpenAI-compatible endpoint rather than a built-in backend. */
  custom: boolean;
}

/** Fronts every sub-provider as a single VS Code model provider. */
export class UnifiedProvider extends BaseAIProvider {
  readonly id = "free-ai-vscode";
  readonly displayName = "AI Free VSCode";

  /** Built at build time; never changes while the extension runs. */
  private readonly builtIn: BaseAIProvider[];
  /** Rebuilt from settings whenever the user edits their own endpoints. */
  private custom: BaseAIProvider[] = [];

  /** Invalidated on every provider-set change; rebuilt on first use. */
  private modelIndex?: Map<string, BaseAIProvider>;
  private readonly authDisposables = new Map<
    BaseAIProvider,
    vscode.Disposable
  >();

  constructor(providers: BaseAIProvider[]) {
    super();
    this.builtIn = providers;
    for (const provider of providers) this.watchAuth(provider);
  }

  /**
   * Replaces the user-defined providers. The old ones are disposed, so a
   * removed endpoint stops answering immediately, and the model list is
   * refreshed through onDidAuthChange.
   */
  setCustomProviders(providers: BaseAIProvider[]): void {
    for (const provider of this.custom) {
      this.authDisposables.get(provider)?.dispose();
      this.authDisposables.delete(provider);
      provider.dispose();
    }

    this.custom = providers;
    for (const provider of providers) this.watchAuth(provider);

    this.modelIndex = undefined;
    log(
      `[unified] custom providers: ${providers.map((p) => p.displayName).join(", ") || "(none)"}`,
    );
    this._onDidAuthChange.fire();
  }

  /** Built-in providers first, then the user's own. */
  private get providers(): BaseAIProvider[] {
    return [...this.builtIn, ...this.custom];
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
        custom: this.custom.includes(provider),
      });
    }
    return states;
  }

  /** The backend behind a model speaks the OpenAI tools API natively. */
  override supportsNativeToolCalls(modelId: string): boolean {
    return this.providerForModel(modelId)?.nativeToolCalls === true;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isAuthenticated(secrets)) return true;
    }
    return false;
  }

  async login(
    secrets: vscode.SecretStorage,
    providerId?: string,
  ): Promise<void> {
    await this.pickAndRun("Sign In", providerId, (p) => p.login(secrets));
  }

  async logout(
    secrets: vscode.SecretStorage,
    providerId?: string,
  ): Promise<void> {
    await this.pickAndRun("Sign Out", providerId, (p) => p.logout(secrets));
  }

  sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const provider = this.providerForModel(params.model);
    if (!provider) {
      throw new Error(`Model is not registered: ${params.model}`);
    }
    return provider.sendMessageStream(params, secrets);
  }

  override dispose(): void {
    for (const d of this.authDisposables.values()) d.dispose();
    this.authDisposables.clear();
    for (const provider of this.providers) provider.dispose();
    this.custom = [];
    super.dispose();
  }

  private watchAuth(provider: BaseAIProvider): void {
    this.authDisposables.set(
      provider,
      provider.onDidAuthChange(() => {
        // A custom provider can gain or lose models on sign-in (its list comes
        // from the endpoint), so the index cannot be cached across that.
        this.modelIndex = undefined;
        this._onDidAuthChange.fire();
      }),
    );
  }

  private providerForModel(modelId: string): BaseAIProvider | undefined {
    if (!this.modelIndex) {
      this.modelIndex = new Map();
      for (const provider of this.providers) {
        for (const model of provider.getModels()) {
          const owner = this.modelIndex.get(model.id);
          if (owner) {
            // Custom endpoints are namespaced, so this means two backends
            // really do claim the same id: the first one keeps it.
            log(
              `[unified] model id collision "${model.id}": kept ${owner.id}, ignored ${provider.id}`,
            );
            continue;
          }
          this.modelIndex.set(model.id, provider);
        }
      }
    }
    return this.modelIndex.get(modelId);
  }

  private async pickAndRun(
    action: string,
    providerId: string | undefined,
    run: (provider: BaseAIProvider) => Promise<void>,
  ): Promise<void> {
    let target = providerId
      ? this.providers.find((p) => p.id === providerId)
      : undefined;

    if (!target) {
      if (providerId) throw new Error(`Provider not found: ${providerId}`);

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

      target = this.providers.find((p) => p.id === selected.value);
      if (!target) throw new Error(`Provider not found: ${selected.value}`);
    }

    await run(target);
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
