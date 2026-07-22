import * as vscode from "vscode";
import { errToString, log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import { isAbortError, isNetworkFailure } from "../common/http";
import { conversationKey } from "../common/messages";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import type { DeepSeekAuthState } from "./DeepSeekApiClient";
import { DeepSeekApiClient } from "./DeepSeekApiClient";
import { DeepSeekAuthManager } from "./DeepSeekAuthManager";
import { DEEPSEEK_MODELS } from "./DeepSeekModels";

/** Backoff before re-entering the single generation slot. */
const PARALLEL_LIMIT_RETRY_DELAYS_MS = [1500, 4000];

/** Backoff after a dropped connection. Prompts here are ~100 KB, so retries
 *  are not free — two attempts, then give the error to the user. */
const NETWORK_RETRY_DELAYS_MS = [1000, 3000];

/** Where the Expert model falls back to when the upstream is overloaded. */
const DEFAULT_MODEL_ID = "deepseek-default";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One retry of the request: where to send it and with which model. */
interface Attempt {
  sessionId: string;
  parentId?: number;
  model?: string;
}

export class DeepSeekProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-deepseek";
  readonly displayName = "DeepSeek (Web)";

  private readonly authManager = new DeepSeekAuthManager();
  private readonly apiClient = new DeepSeekApiClient();
  private readonly sessionIdByConversation = new Map<string, string>();
  private readonly parentMessageIdByConversation = new Map<string, number>();

  /**
   * DeepSeek allows one generation per ACCOUNT, not per session. Copilot Chat
   * happily fires several requests at once (the answer plus its housekeeping
   * calls), and the losers came back with `parallel_chat_limit` and an empty
   * answer. Requests are therefore queued instead of raced.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Session creation happens before the streaming recovery ladder can help, so
   * it carries its own retry: the TLS handshake to chat.deepseek.com gets reset
   * often enough that a single failure must not surface as a chat error.
   */
  private async createSession(
    auth: DeepSeekAuthState,
    signal?: AbortSignal,
  ): Promise<string> {
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt <= NETWORK_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      if (attempt > 0) {
        log(
          `[${this.id}] session create failed (${errToString(lastError)}) — retrying in ${NETWORK_RETRY_DELAYS_MS[attempt - 1]}ms`,
        );
        await delay(NETWORK_RETRY_DELAYS_MS[attempt - 1]);
      }
      try {
        return await this.apiClient.createSession(auth, signal);
      } catch (err) {
        lastError = err;
        if (!isNetworkFailure(err) || signal?.aborted) throw err;
      }
    }

    throw lastError;
  }

  private async acquireSlot(): Promise<() => void> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    return release;
  }

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

    const release = await this.acquireSlot();
    try {
      // The wait can outlive the request that was queued.
      if (params.abortSignal?.aborted) return;
      yield* this.streamInSlot(params, auth);
    } finally {
      release();
    }
  }

  private async *streamInSlot(
    params: AIRequestParams,
    auth: NonNullable<Awaited<ReturnType<DeepSeekAuthManager["getAuth"]>>>,
  ): AsyncIterable<AIStreamChunk> {
    const key = conversationKey(params);
    let sessionId = params.chatId ?? this.sessionIdByConversation.get(key);
    let parentMessageId = this.parentMessageIdByConversation.get(key);

    if (!sessionId) {
      sessionId = await this.createSession(auth, params.abortSignal);
      this.sessionIdByConversation.set(key, sessionId);
      parentMessageId = undefined;
      this.parentMessageIdByConversation.delete(key);
      log(
        `[${this.id}] created session_id=${sessionId} key=${key.slice(0, 12)}…`,
      );
    }

    // Anything already shown to the user makes a retry unsafe: the answer
    // would be streamed twice.
    let streamedToUser = false;

    const runAttempt = async function* (
      this: DeepSeekProvider,
      attempt: Attempt,
    ): AsyncIterable<AIStreamChunk> {
      let lastMessageId = attempt.parentId;
      let produced = false;

      try {
        const stream = this.apiClient.sendMessageStream(
          {
            ...params,
            model: attempt.model ?? params.model,
            chatId: attempt.sessionId,
            parentId:
              typeof attempt.parentId === "number"
                ? String(attempt.parentId)
                : undefined,
          },
          auth,
          {
            onMessageId: (messageId) => {
              lastMessageId = messageId;
            },
          },
        );

        for await (const chunk of stream) {
          if (chunk.type === "text" || chunk.type === "tool_call") {
            produced = true;
            streamedToUser = true;
          }
          yield chunk;
        }

        // Chain onto this message only if the turn actually said something.
        // An empty answer leaves an id the session does not accept back, and
        // the next turn would fail with "invalid message id".
        if (produced && typeof lastMessageId === "number") {
          this.parentMessageIdByConversation.set(key, lastMessageId);
        } else {
          this.parentMessageIdByConversation.delete(key);
        }
      } catch (err) {
        if (
          isAbortError(err, params.abortSignal) &&
          typeof lastMessageId === "number"
        ) {
          await this.apiClient
            .stopStream(auth, attempt.sessionId, lastMessageId)
            .catch(() => undefined);
        }

        throw err;
      }
    };

    /** Retry the exact same request after a pause — nothing is wrong with it. */
    const waitAndRetry =
      (ms: number, reason: string) => async (): Promise<Attempt> => {
        log(`[${this.id}] ${reason} — retrying in ${ms}ms`);
        await delay(ms);
        return { sessionId, parentId: parentMessageId };
      };

    /**
     * The Expert model is overloaded and the upstream itself suggests the
     * default one ("Instant Mode"). Same session and parent — only the model
     * changes, so the conversation carries on.
     */
    const useDefaultModel = async (): Promise<Attempt> => {
      log(`[${this.id}] expert model busy — falling back to the default model`);
      return {
        sessionId,
        parentId: parentMessageId,
        model: DEFAULT_MODEL_ID,
      };
    };

    /** The parent message is gone; the session itself is still fine. */
    const withoutParent = async (): Promise<Attempt> => {
      log(`[${this.id}] stale parent_message_id — retrying without it`);
      this.parentMessageIdByConversation.delete(key);
      return { sessionId };
    };

    /**
     * Abandon the session. Used when its previous generation is still running:
     * stopping that would cut off a request the editor may still be streaming,
     * and nothing is lost — the whole history goes out in the prompt anyway.
     */
    const freshSession = async (): Promise<Attempt> => {
      log(`[${this.id}] retrying in a fresh session`);
      const freshSessionId = await this.createSession(auth, params.abortSignal);
      this.sessionIdByConversation.set(key, freshSessionId);
      this.parentMessageIdByConversation.delete(key);
      return { sessionId: freshSessionId };
    };

    let lastError: unknown;
    try {
      yield* runAttempt.call(this, { sessionId, parentId: parentMessageId });
      return;
    } catch (err) {
      lastError = err;
    }

    const stepsFor = (error: unknown): Array<() => Promise<Attempt>> => {
      if (isParallelLimit(error)) {
        return PARALLEL_LIMIT_RETRY_DELAYS_MS.map((ms) =>
          waitAndRetry(ms, "generation slot busy"),
        );
      }
      if (isNetworkFailure(error)) {
        return NETWORK_RETRY_DELAYS_MS.map((ms) =>
          waitAndRetry(ms, `connection failed (${errToString(error)})`),
        );
      }
      if (isExpertBusy(error)) return [useDefaultModel];
      if (isSessionBusy(error)) return [freshSession];
      return [withoutParent, freshSession];
    };

    for (const step of stepsFor(lastError)) {
      if (
        !isRecoverable(lastError) ||
        streamedToUser ||
        params.abortSignal?.aborted
      ) {
        break;
      }
      try {
        yield* runAttempt.call(this, await step());
        return;
      } catch (retryErr) {
        lastError = retryErr;
      }
    }

    if (lastError instanceof AuthExpiredError) {
      this._onDidAuthChange.fire();
    }
    throw lastError;
  }
}

/**
 * One generation per account, not per session: another request (ours or from
 * another device) is still being answered.
 */
function isParallelLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    /parallel_chat_limit|message is being generated/i.test(error.message)
  );
}

/** Server still generating the previous answer in this session. */
function isSessionBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    /biz error\s*11|message still wip/i.test(error.message)
  );
}

/** parent_message_id points at a message the session no longer knows. */
function isStaleParent(error: unknown): boolean {
  return (
    error instanceof Error &&
    /biz error\s*26|invalid message id/i.test(error.message)
  );
}

/**
 * The Expert model itself is overloaded. The upstream suggests its default
 * ("Instant") model, which is exactly what the fallback does.
 */
function isExpertBusy(error: unknown): boolean {
  return (
    error instanceof Error && /expert_busy_use_default/i.test(error.message)
  );
}

function isRecoverable(error: unknown): boolean {
  return (
    isSessionBusy(error) ||
    isStaleParent(error) ||
    isParallelLimit(error) ||
    isExpertBusy(error) ||
    isNetworkFailure(error)
  );
}
