import * as vscode from "vscode";
import { log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError } from "../types";
import { DeepSeekApiClient } from "./DeepSeekApiClient";
import { DeepSeekAuthManager } from "./DeepSeekAuthManager";
import { DEEPSEEK_MODELS } from "./DeepSeekModels";

export class DeepSeekProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-deepseek";
  readonly displayName = "DeepSeek (Free)";

  private readonly authManager = new DeepSeekAuthManager();
  private readonly apiClient = new DeepSeekApiClient();
  private readonly sessionIdByConversation = new Map<string, string>();
  private readonly parentMessageIdByConversation = new Map<string, number>();

  getModels(): AIModelInfo[] {
    return DEEPSEEK_MODELS;
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
    this.sessionIdByConversation.clear();
    this.parentMessageIdByConversation.clear();
    this._onDidAuthChange.fire();
  }

  async *sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const auth = await this.authManager.getAuth(secrets);
    if (!auth) {
      throw new AuthExpiredError(this.id);
    }

    const key = this.buildConversationKey(params);
    let sessionId = params.chatId ?? this.sessionIdByConversation.get(key);
    let parentMessageId = this.parentMessageIdByConversation.get(key);

    if (!sessionId) {
      sessionId = await this.apiClient.createSession(auth, params.abortSignal);
      this.sessionIdByConversation.set(key, sessionId);
      parentMessageId = undefined;
      this.parentMessageIdByConversation.delete(key);
      log(
        `[${this.id}] created session_id=${sessionId} key=${key.slice(0, 12)}…`,
      );
    }

    const runAttempt = async function* (
      this: DeepSeekProvider,
      currentSessionId: string,
      currentParentMessageId?: number,
    ): AsyncIterable<AIStreamChunk> {
      let lastMessageId = currentParentMessageId;

      try {
        yield* this.apiClient.sendMessageStream(
          {
            ...params,
            chatId: currentSessionId,
            parentId:
              typeof currentParentMessageId === "number"
                ? String(currentParentMessageId)
                : undefined,
          },
          auth,
          {
            onMessageId: (messageId) => {
              lastMessageId = messageId;
            },
          },
        );

        if (typeof lastMessageId === "number") {
          this.parentMessageIdByConversation.set(key, lastMessageId);
        } else {
          this.parentMessageIdByConversation.delete(key);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort =
          !!params.abortSignal?.aborted ||
          err instanceof DOMException ||
          /abort/i.test(msg);

        if (isAbort && typeof lastMessageId === "number") {
          await this.apiClient
            .stopStream(auth, currentSessionId, lastMessageId)
            .catch(() => undefined);
        }

        throw err;
      }
    };

    try {
      yield* runAttempt.call(this, sessionId, parentMessageId);
    } catch (err) {
      if (this.isInvalidMessageIdError(err)) {
        log(
          `[${this.id}] invalid parent_message_id detected, retrying with reset parent in existing session`,
        );

        this.parentMessageIdByConversation.delete(key);

        try {
          yield* runAttempt.call(this, sessionId, undefined);
          return;
        } catch (retryErr) {
          if (this.isInvalidMessageIdError(retryErr)) {
            log(
              `[${this.id}] invalid message id persists, creating fresh session and retrying once`,
            );

            const freshSessionId = await this.apiClient.createSession(
              auth,
              params.abortSignal,
            );
            this.sessionIdByConversation.set(key, freshSessionId);
            this.parentMessageIdByConversation.delete(key);

            yield* runAttempt.call(this, freshSessionId, undefined);
            return;
          }

          if (retryErr instanceof AuthExpiredError) {
            this._onDidAuthChange.fire();
          }

          throw retryErr;
        }
      }

      if (err instanceof AuthExpiredError) {
        this._onDidAuthChange.fire();
      }

      throw err;
    }
  }

  private isInvalidMessageIdError(error: unknown): boolean {
    if (!(error instanceof ProviderError) && !(error instanceof Error)) {
      return false;
    }

    const msg = error.message ?? "";
    return /biz error\s*26|invalid message id/i.test(msg);
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
