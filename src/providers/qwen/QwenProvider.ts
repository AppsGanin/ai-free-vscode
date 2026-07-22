import * as vscode from "vscode";
import { log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import { QwenApiClient } from "./QwenApiClient";
import { QwenAuthManager } from "./QwenAuthManager";
import { QwenBrowserBridge } from "./QwenBrowserBridge";
import { QWEN_MODELS, resolveModelId, toQwenApiModelType } from "./QwenModels";

export class QwenProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-qwen";
  readonly displayName = "Qwen (Web)";

  private readonly authManager = new QwenAuthManager();
  private readonly browser = new QwenBrowserBridge(
    (message) => {
      void vscode.window.showWarningMessage(message);
    },
    vscode.workspace
      .getConfiguration("freeAI")
      .get<"auto" | "headed" | "headless">("qwen.browserMode", "auto"),
  );
  private readonly apiClient = new QwenApiClient(this.browser);
  private readonly chatIdByConversation = new Map<string, string>();

  // ─── BaseAIProvider implementation ───────────────────────────────────────

  getModels(): AIModelInfo[] {
    return QWEN_MODELS;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return this.authManager.isAuthenticated(secrets);
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    // Persistent-профиль нельзя открыть двумя контекстами сразу: гасим мост
    // перед интерактивным входом.
    await this.browser.close();
    await this.authManager.login(secrets);
    this._onDidAuthChange.fire();
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await this.browser.close();
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

    // Клиент может уйти в новый chat_id (занятый чат, обрыв, internal error).
    // Без переезда кэша следующий ход снова постучится в мёртвый чат.
    const rememberChatId = (newChatId: string) => {
      this.chatIdByConversation.set(conversationKey, newChatId);
      log(`[${this.id}] chat_id switched to ${newChatId}`);
    };

    try {
      yield* this.apiClient.sendMessageStream(
        {
          ...params,
          chatId,
        },
        token,
        rememberChatId,
      );
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) {
        throw err;
      }

      // Токен протух. Живая браузерная сессия (cookies в профиле) может быть ещё
      // валидна — пробуем достать свежий Bearer из localStorage и повторить один раз.
      const refreshed = await this.tryRefreshToken(secrets, token);
      if (refreshed) {
        log(`[${this.id}] token refreshed from live session, retrying request`);
        try {
          yield* this.apiClient.sendMessageStream(
            { ...params, chatId },
            refreshed,
            rememberChatId,
          );
          return;
        } catch (retryErr) {
          if (retryErr instanceof AuthExpiredError) {
            this._onDidAuthChange.fire();
          }
          throw retryErr;
        }
      }

      // Обновить не удалось — уведомляем и пробрасываем выше.
      this._onDidAuthChange.fire();
      throw err;
    }
  }

  /**
   * Пытается получить свежий токен из живой браузерной сессии и сохранить его.
   * Возвращает новый токен, только если он отличается от текущего.
   */
  private async tryRefreshToken(
    secrets: vscode.SecretStorage,
    current: string,
  ): Promise<string | undefined> {
    const raw = await this.browser.readToken().catch(() => undefined);
    if (!raw) {
      return undefined;
    }
    const stored = await this.authManager.saveToken(secrets, raw);
    if (!stored || stored === current) {
      return undefined;
    }
    return stored;
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
