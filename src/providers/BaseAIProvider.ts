import * as vscode from "vscode";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "./types";

/**
 * Base class for every AI provider.
 *
 * To add one: create `src/providers/<name>/`, extend this class and register
 * the key in providerConfig.ts + extension.ts.
 */
export abstract class BaseAIProvider implements vscode.Disposable {
  /** Unique id; matches the vendor in package.json for the top-level provider. */
  abstract readonly id: string;
  abstract readonly displayName: string;

  protected readonly _onDidAuthChange = new vscode.EventEmitter<void>();
  readonly onDidAuthChange: vscode.Event<void> = this._onDidAuthChange.event;

  abstract getModels(): AIModelInfo[];

  /** Models usable right now. Composite providers filter by sub-provider. */
  async getAvailableModels(
    secrets: vscode.SecretStorage,
  ): Promise<AIModelInfo[]> {
    return (await this.isAuthenticated(secrets)) ? this.getModels() : [];
  }

  /** Must be fast: SecretStorage only, never a network call. */
  abstract isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean>;

  /** Runs the sign-in flow, stores the result and fires onDidAuthChange. */
  abstract login(secrets: vscode.SecretStorage): Promise<void>;

  abstract logout(secrets: vscode.SecretStorage): Promise<void>;

  /** Throws AuthExpiredError / RateLimitError / ProviderError on failure. */
  abstract sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk>;

  dispose(): void {
    this._onDidAuthChange.dispose();
  }
}
