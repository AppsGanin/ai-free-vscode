import * as vscode from "vscode";
import { createLogger } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import { MimoApiClient } from "./MimoApiClient";
import { MimoAuthManager } from "./MimoAuthManager";
import { MIMO_MODELS } from "./MimoModels";
import { MimoServer } from "./MimoServer";

const log = createLogger("mimo");

/**
 * MiMo (Xiaomi) через официальный CLI `mimo` — бесплатный анонимный канал
 * MiMo Auto.
 *
 * Ни ключей, ни токенов, ни входа: расширение поднимает локальный
 * headless-сервер mimocode (`mimo serve`) и общается с ним по HTTP/SSE.
 * Единственное условие — установленный CLI.
 */
export class MimoProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-mimo";
  readonly displayName = "MiMo Code (CLI)";

  private readonly authManager = new MimoAuthManager();
  private readonly server = new MimoServer();
  private readonly apiClient = new MimoApiClient(this.server);

  getModels(): AIModelInfo[] {
    return MIMO_MODELS;
  }

  /** Модель показываем, только если её реально отдаёт CLI (`mimo models`). */
  override async getAvailableModels(): Promise<AIModelInfo[]> {
    const ids = await this.authManager.availableModelIds();
    return MIMO_MODELS.filter((model) => ids.includes(model.id));
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authManager.isAuthenticated();
  }

  async login(): Promise<void> {
    await this.authManager.login();
    this._onDidAuthChange.fire();
  }

  async logout(): Promise<void> {
    await this.authManager.logout();
    this.server.stop();
    this._onDidAuthChange.fire();
  }

  async *sendMessageStream(
    params: AIRequestParams,
    _secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    void _secrets;

    log.debug(`sendMessage: model=${params.model}`);
    try {
      yield* this.apiClient.sendMessageStream(params);
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        log.warn("sendMessage: CLI is not signed in");
        this._onDidAuthChange.fire();
      }
      throw err;
    }
  }

  override dispose(): void {
    this.server.dispose();
    super.dispose();
  }
}
