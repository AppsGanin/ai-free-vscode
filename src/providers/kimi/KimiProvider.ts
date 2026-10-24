import { createLogger } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk, SecretStore } from "../types";
import { AuthExpiredError } from "../types";
import { KimiApiClient } from "./KimiApiClient";
import { KimiAuthManager, expiresSoon } from "./KimiAuthManager";
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
    let auth = await this.authManager.getAuth(secrets);
    if (!auth) {
      log.warn("sendMessage: not authenticated");
      throw new AuthExpiredError(this.id);
    }
    // The access token lives about 15 minutes: renewed ahead, not after a
    // refused request.
    if (expiresSoon(auth.token)) {
      auth = (await this.authManager.refresh(secrets, auth)) ?? auth;
    }

    log.debug(`sendMessage: model=${params.model}`);
    let shown = false;
    try {
      for await (const chunk of this.apiClient.sendMessageStream(params, auth)) {
        shown = true;
        yield chunk;
      }
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) throw err;
      log.warn("sendMessage: auth expired mid-request");
      if (!shown && err.rejectsCredential) {
        const fresh = await this.authManager.refresh(secrets, auth);
        if (fresh) {
          log.info("sendMessage: token refreshed, retrying the request");
          try {
            yield* this.apiClient.sendMessageStream(params, fresh);
            return;
          } catch (retryErr) {
            if (!(retryErr instanceof AuthExpiredError)) throw retryErr;
            auth = fresh;
            err = retryErr;
          }
        }
      }
      // A refused token must not be sent again: show Sign In instead.
      if ((err as AuthExpiredError).rejectsCredential) {
        await this.authManager.forget(secrets, auth.token);
      }
      this._onDidAuthChange.fire();
      throw err;
    }
  }
}
