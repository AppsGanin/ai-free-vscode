import * as vscode from "vscode";
import { log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import { conversationKey } from "../common/messages";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import { QwenApiClient } from "./QwenApiClient";
import { QwenAuthManager } from "./QwenAuthManager";
import { QwenBrowserBridge } from "./QwenBrowserBridge";
import { QWEN_MODELS, resolveModelId } from "./QwenModels";

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

  getModels(): AIModelInfo[] {
    return QWEN_MODELS;
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    return this.authManager.isAuthenticated(secrets);
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    // A persistent profile cannot be opened by two contexts at once: shut the
    // bridge down before the interactive sign-in.
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

    const key = conversationKey(params);

    try {
      yield* this.attempt(params, key, token);
    } catch (err) {
      if (!(err instanceof AuthExpiredError)) {
        throw err;
      }

      // Token expired, but the live browser session (profile cookies) may still
      // be valid — pull a fresh Bearer from localStorage and retry once.
      const refreshed = await this.tryRefreshToken(secrets, token);
      if (refreshed) {
        log(`[${this.id}] token refreshed from live session, retrying request`);
        try {
          yield* this.attempt(params, key, refreshed);
          return;
        } catch (retryErr) {
          if (retryErr instanceof AuthExpiredError) {
            this._onDidAuthChange.fire();
          }
          throw retryErr;
        }
      }

      this._onDidAuthChange.fire();
      throw err;
    }
  }

  /**
   * One whole attempt on a single Bearer: open a chat if there is none yet,
   * then stream into it.
   *
   * Chat creation is part of the attempt on purpose. Qwen reports an expired
   * token on `chats/new` just as readily as on the stream (HTTP 200 with
   * `code: "unauthorized"`), and while this ran outside the caller's try the
   * refresh never got a chance at the most common failure of the two.
   */
  private async *attempt(
    params: AIRequestParams,
    key: string,
    token: string,
  ): AsyncIterable<AIStreamChunk> {
    let chatId = params.chatId ?? this.chatIdByConversation.get(key);

    if (!chatId) {
      chatId = await this.apiClient.createChat(
        token,
        resolveModelId(params.model),
      );
      this.chatIdByConversation.set(key, chatId);
      log(`[${this.id}] created provider chat_id=${chatId}`);
    }

    yield* this.apiClient.sendMessageStream(
      { ...params, chatId },
      token,
      // The client may move to a new chat_id (busy chat, drop, internal error);
      // without updating the cache the next turn hits the dead chat again.
      (newChatId: string) => {
        this.chatIdByConversation.set(key, newChatId);
        log(`[${this.id}] chat_id switched to ${newChatId}`);
      },
    );
  }

  /** Reads a fresh token from the live browser session; undefined if unchanged. */
  private async tryRefreshToken(
    secrets: vscode.SecretStorage,
    current: string,
  ): Promise<string | undefined> {
    const raw = await this.browser.readToken().catch(() => undefined);
    if (!raw) return undefined;
    const stored = await this.authManager.saveToken(secrets, raw);
    return stored && stored !== current ? stored : undefined;
  }
}
