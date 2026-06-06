import * as vscode from "vscode";
import { BaseAIProvider } from "./BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "./types";

export class UnifiedProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode";
  readonly displayName = "AI Free VSCode";

  private readonly modelToProvider = new Map<string, BaseAIProvider>();
  private readonly authDisposables: vscode.Disposable[] = [];

  constructor(private readonly providers: BaseAIProvider[]) {
    super();

    for (const provider of providers) {
      for (const model of provider.getModels()) {
        if (this.modelToProvider.has(model.id)) {
          throw new Error(
            `Model id collision: "${model.id}" is already registered by another provider`,
          );
        }
        this.modelToProvider.set(model.id, provider);
      }

      this.authDisposables.push(
        provider.onDidAuthChange(() => {
          this._onDidAuthChange.fire();
        }),
      );
    }
  }

  getModels(): AIModelInfo[] {
    return this.collectModels(this.providers);
  }

  /**
   * Только модели тех под-провайдеров, в которые пользователь реально вошёл.
   * Без этого в model picker (и в "auto" для коммитов) попадали модели
   * неавторизованных провайдеров, и запрос к ним падал с ошибкой авторизации.
   */
  override async getAvailableModels(
    secrets: vscode.SecretStorage,
  ): Promise<AIModelInfo[]> {
    const authed: BaseAIProvider[] = [];
    for (const provider of this.providers) {
      if (await provider.isAuthenticated(secrets)) {
        authed.push(provider);
      }
    }
    return this.collectModels(authed);
  }

  private collectModels(providers: BaseAIProvider[]): AIModelInfo[] {
    const seen = new Set<string>();
    const all: AIModelInfo[] = [];

    for (const provider of providers) {
      const providerTag = this.getProviderTag(provider);

      for (const model of provider.getModels()) {
        if (seen.has(model.id)) {
          continue;
        }
        seen.add(model.id);

        const prefixedName = model.name.startsWith(`[${providerTag}] `)
          ? model.name
          : `[${providerTag}] ${model.name}`;

        const prefixedFamily = model.family.startsWith(`${providerTag}/`)
          ? model.family
          : `${providerTag}/${model.family}`;

        all.push({
          ...model,
          name: prefixedName,
          family: prefixedFamily,
        });
      }
    }

    return all;
  }

  private getProviderTag(provider: BaseAIProvider): string {
    const normalized = provider.displayName
      .replace(/\s*\(.*\)\s*$/g, "")
      .trim();
    return normalized || provider.id;
  }

  /**
   * Состояние авторизации по каждому под-провайдеру — для детального статуса
   * в UI (какой провайдер залогинен, а какой нет).
   */
  async getProviderAuthStates(
    secrets: vscode.SecretStorage,
  ): Promise<Array<{ id: string; name: string; authenticated: boolean }>> {
    const states: Array<{ id: string; name: string; authenticated: boolean }> =
      [];
    for (const provider of this.providers) {
      states.push({
        id: provider.id,
        name: this.getProviderTag(provider),
        authenticated: await provider.isAuthenticated(secrets),
      });
    }
    return states;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.isAuthenticated(secrets)) {
        return true;
      }
    }
    return false;
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    const picks = [
      ...this.providers.map((provider) => ({
        label: provider.displayName,
        description: provider.id,
        value: provider.id as string,
      })),
    ];

    const selected = await vscode.window.showQuickPick(picks, {
      title: "Select a provider to sign in",
      placeHolder: "Sign In",
      ignoreFocusOut: true,
    });

    if (!selected) {
      return;
    }

    if (selected.value === "all") {
      for (const provider of this.providers) {
        await provider.login(secrets);
      }
      this._onDidAuthChange.fire();
      return;
    }

    const provider = this.providers.find((p) => p.id === selected.value);
    if (!provider) {
      throw new Error(`Provider not found: ${selected.value}`);
    }

    await provider.login(secrets);
    this._onDidAuthChange.fire();
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    const picks = [
      ...this.providers.map((provider) => ({
        label: provider.displayName,
        description: provider.id,
        value: provider.id as string,
      })),
    ];

    const selected = await vscode.window.showQuickPick(picks, {
      title: "Select a provider to sign out",
      placeHolder: "Sign Out",
      ignoreFocusOut: true,
    });

    if (!selected) {
      return;
    }

    if (selected.value === "all") {
      for (const provider of this.providers) {
        await provider.logout(secrets);
      }
      this._onDidAuthChange.fire();
      return;
    }

    const provider = this.providers.find((p) => p.id === selected.value);
    if (!provider) {
      throw new Error(`Provider not found: ${selected.value}`);
    }

    await provider.logout(secrets);
    this._onDidAuthChange.fire();
  }

  sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const provider = this.modelToProvider.get(params.model);
    if (!provider) {
      throw new Error(
        `Model is not registered in unified provider: ${params.model}`,
      );
    }

    return provider.sendMessageStream(params, secrets);
  }

  override dispose(): void {
    for (const d of this.authDisposables) {
      d.dispose();
    }
    this.authDisposables.length = 0;

    for (const provider of this.providers) {
      provider.dispose();
    }

    super.dispose();
  }
}
