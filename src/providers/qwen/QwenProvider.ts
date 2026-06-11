import * as vscode from "vscode";
import { log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import { QwenApiClient } from "./QwenApiClient";
import { QwenAuthManager } from "./QwenAuthManager";
import { QWEN_MODELS, resolveModelId, toQwenApiModelType } from "./QwenModels";

export class QwenProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode";
  readonly displayName = "Qwen (Free)";

  private readonly authManager = new QwenAuthManager();
  private readonly apiClient = new QwenApiClient();
  private readonly chatIdByConversation = new Map<string, string>();

  // ─── BaseAIProvider implementation ───────────────────────────────────────

  getModels(): AIModelInfo[] {
    return QWEN_MODELS;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return this.authManager.isAuthenticated(secrets);
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    await this.authManager.login(secrets);
    this._onDidAuthChange.fire();
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await this.authManager.logout(secrets);
    this.chatIdByConversation.clear();
    this._onDidAuthChange.fire();
  }

  async *sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const token = await this.authManager.getToken(secrets);
    if (!token) {
      throw new AuthExpiredError(this.id);
    }

    const conversationKey = this.buildConversationKey(params);
    let chatId =
      params.chatId ?? this.chatIdByConversation.get(conversationKey);

    if (!chatId) {
      const apiModelType = toQwenApiModelType(resolveModelId(params.model));
      chatId = await this.apiClient.createChat(token, apiModelType);
      if (!chatId) {
        throw new Error("Failed to create chat_id for Qwen");
      }
      this.chatIdByConversation.set(conversationKey, chatId);
      log(
        `[${this.id}] created provider chat_id=${chatId} key=${conversationKey.slice(0, 12)}…`,
      );
    }

    try {
      yield* this.apiClient.sendMessageStream(
        {
          ...params,
          chatId,
        },
        token,
      );
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        // Токен протух — уведомляем и пробрасываем выше
        this._onDidAuthChange.fire();
      }
      throw err;
    }
  }

  private buildConversationKey(params: AIRequestParams): string {
    const firstUser = params.messages.find((m) => m.role === "user");
    const firstUserText = firstUser
      ? this.messageContentToString(firstUser.content).slice(0, 600)
      : "";

    const basis = `${params.model}::${firstUserText}`;
    return this.hashString(basis);
  }

  private messageContentToString(
    content: AIRequestParams["messages"][number]["content"],
  ): string {
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((part) => (part.type === "text" ? part.text : "[image]"))
      .join("\n");
  }

  private hashString(value: string): string {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }
}
