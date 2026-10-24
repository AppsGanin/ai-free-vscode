import { createLogger } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk, SecretStore } from "../types";
import { AuthExpiredError } from "../types";
import { KimiApiClient } from "./KimiApiClient";
import { KimiAuthManager } from "./KimiAuthManager";
import { KIMI_MODELS } from "./KimiModels";

const log = createLogger("kimi");

export class KimiProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-kimi";
  readonly displayName = "Kimi (Web)";

  private readonly authManager = new KimiAuthManager();
  private readonly apiClient = new KimiApiClient();

  getModels(): AIModelInfo[] {
    return KIMI_MODELS;
  }

  async isAuthenticated(secrets: SecretStore): Promise<boolean> {
    return this.authManager.isAuthenticated(secrets);
  }

  async login(secrets: SecretStore): Promise<void> {
    await this.authManager.login(secrets);
    this._onDidAuthChange.fire();
  }

  async logout(secrets: SecretStore): Promise<void> {
    await this.authManager.logout(secrets);
    this._onDidAuthChange.fire();
  }

  async *sendMessageStream(
    params: AIRequestParams,
    secrets: SecretStore,
  ): AsyncIterable<AIStreamChunk> {
    const auth = await this.authManager.getAuth(secrets);
    if (!auth) {
      log.warn("sendMessage: not authenticated");
      throw new AuthExpiredError(this.id);
    }

    log.debug(`sendMessage: model=${params.model}`);
    try {
      yield* this.apiClient.sendMessageStream(params, auth);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        log.warn("sendMessage: auth expired mid-request");
        // A refused token must not be sent again: show Sign In instead.
        if (err.rejectsCredential) await this.authManager.forget(secrets, auth.token);
        this._onDidAuthChange.fire();
      }
      throw err;
    }
  }
}
