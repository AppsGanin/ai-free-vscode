import * as vscode from "vscode";
import type { BaseAIProvider } from "../providers/BaseAIProvider";
import { VSCodeLMAdapter } from "./VSCodeLMAdapter";

/**
 * Реестр провайдеров. Регистрирует каждый провайдер в VS Code LM API.
 * Добавить нового провайдера = вызвать registry.register(new MyProvider()).
 */
export class ProviderRegistry implements vscode.Disposable {
  private readonly providers = new Map<string, BaseAIProvider>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /**
   * Регистрирует провайдер и подключает его к VS Code Language Model API.
   * @param provider Экземпляр провайдера extends BaseAIProvider
   */
  register(provider: BaseAIProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(
        `Provider with id "${provider.id}" is already registered`,
      );
    }

    this.providers.set(provider.id, provider);

    const adapter = new VSCodeLMAdapter(provider, this.secrets);

    const registration = vscode.lm.registerLanguageModelChatProvider(
      provider.id,
      adapter,
    );

    this.disposables.push(registration, adapter, provider);
  }

  /**
   * Возвращает все зарегистрированные провайдеры (для генерации команд).
   */
  getAll(): ReadonlyMap<string, BaseAIProvider> {
    return this.providers;
  }

  /**
   * Возвращает провайдер по ID или undefined.
   */
  get(id: string): BaseAIProvider | undefined {
    return this.providers.get(id);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.providers.clear();
  }
}
