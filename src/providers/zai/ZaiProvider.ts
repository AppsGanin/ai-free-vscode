import * as vscode from "vscode";
import { createLogger } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import { ZaiApiClient } from "./ZaiApiClient";
import { ZaiAuthManager } from "./ZaiAuthManager";
import { ZaiBrowserBridge } from "./ZaiBrowserBridge";
import { ZAI_MODELS } from "./ZaiModels";

const log = createLogger("zai");

export class ZaiProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-zai";
  readonly displayName = "Z.ai (Web)";

  private readonly authManager = new ZaiAuthManager();
  private readonly bridge = new ZaiBrowserBridge(
    (message) => {
      void vscode.window.showWarningMessage(message);
    },
    vscode.workspace
      .getConfiguration("freeAI")
      .get<"auto" | "headed" | "headless">("zai.browserMode", "auto"),
  );
  private readonly apiClient = new ZaiApiClient(this.bridge);

  getModels(): AIModelInfo[] {
    return ZAI_MODELS;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return this.authManager.isAuthenticated(secrets);
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    // Sign-in and the bridge share one Chrome profile, which only one browser
    // process may hold.
    await this.bridge.close();
    await this.authManager.login(secrets);
    this._onDidAuthChange.fire();
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await this.bridge.close();
    await this.authManager.logout(secrets);
    this._onDidAuthChange.fire();
  }

  async *sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    if (!(await this.authManager.getAuth(secrets))) {
      log.warn("sendMessage: not authenticated");
      throw new AuthExpiredError(this.id);
    }

    log.debug(`sendMessage: model=${params.model}`);
    try {
      yield* this.apiClient.sendMessageStream(params);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        // The browser profile is no longer signed in: show the provider as
        // signed out so the user is offered Sign In again.
        log.warn("sendMessage: browser session expired");
        await this.authManager.forget(secrets);
        this._onDidAuthChange.fire();
      }
      throw err;
    }
  }

  override dispose(): void {
    void this.bridge.close();
    super.dispose();
  }
}
