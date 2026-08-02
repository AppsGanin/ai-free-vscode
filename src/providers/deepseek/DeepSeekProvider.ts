import * as vscode from "vscode";
import { errToString, log } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import { isAbortError, isNetworkFailure } from "../common/http";
import {
  charBudgetForTokens,
  contentToString,
  conversationKey,
} from "../common/messages";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, RateLimitError } from "../types";
import type { DeepSeekAuthState } from "./DeepSeekApiClient";
import { DeepSeekApiClient, MAX_PROMPT_TOKENS } from "./DeepSeekApiClient";
import { DeepSeekAuthManager } from "./DeepSeekAuthManager";
import { DEEPSEEK_MODELS } from "./DeepSeekModels";

/** Backoff before re-entering the single generation slot. */
const PARALLEL_LIMIT_RETRY_DELAYS_MS = [1500, 4000];

/**
 * Backoff for the account-wide throttle ("Messages too frequent"). It counts
 * turns over a window rather than concurrency, so it needs a real pause — the
 * sub-second backoff a busy generation slot gets would just burn the retries.
 */
const RATE_LIMIT_RETRY_DELAYS_MS = [3000, 8000, 18000];

/** Longest `Retry-After` worth honouring before giving the error to the user. */
const MAX_RETRY_AFTER_MS = 30000;

/** Backoff after a dropped connection. Prompts here are ~100 KB, so retries
 *  are not free — two attempts, then give the error to the user. */
const NETWORK_RETRY_DELAYS_MS = [1000, 3000];

/** Where the Expert model falls back to when the upstream is overloaded. */
const DEFAULT_MODEL_ID = "deepseek-default";

/**
 * How much text one upstream session may accumulate before it is abandoned.
 *
 * The whole conversation is resent as a single prompt on every turn, so a
 * session that chains its messages holds that history once per turn and runs
 * into DeepSeek's "Length limit reached. Please start a new chat." after a few
 * of them. Rolling over to a new session beforehand keeps that failure out of
 * the chat; nothing is lost, because the prompt carries the history anyway.
 *
 * Expressed in tokens and converted per conversation, for the same reason the
 * prompt budget is: the same character count is twice the tokens in Russian.
 */
const SESSION_CONTEXT_BUDGET_TOKENS = MAX_PROMPT_TOKENS;

/**
 * Prompt budgets for the retries after the upstream reported a length limit,
 * as a share of what it just refused. The window depends on the account and on
 * the language of the conversation (Cyrillic costs about twice the tokens per
 * character), so it is found by halving rather than assumed.
 *
 * Relative rather than absolute: a fixed ladder above the size that already
 * failed resends the very same prompt and burns a retry on a certain failure.
 */
const SHRUNK_PROMPT_FRACTIONS = [0.5, 0.25, 0.12];

/** Floor for the ladder — below this a turn carries too little to be useful. */
const MIN_PROMPT_CHARS = 20000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One retry of the request: where to send it and with which model. */
interface Attempt {
  sessionId: string;
  parentId?: number;
  model?: string;
  maxPromptChars?: number;
}

export class DeepSeekProvider extends BaseAIProvider {
  readonly id = "ai-free-vscode-deepseek";
  readonly displayName = "DeepSeek (Web)";

  private readonly authManager = new DeepSeekAuthManager();
  private readonly apiClient = new DeepSeekApiClient();
  private readonly sessionIdByConversation = new Map<string, string>();
  private readonly parentMessageIdByConversation = new Map<string, number>();
  /** Text already pushed into the upstream session, prompts plus answers. */
  private readonly sessionUsageByConversation = new Map<string, number>();
  /** Prompt budget a length-limited conversation was last accepted at. */
  private readonly promptCapByConversation = new Map<string, number>();

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
    this.sessionUsageByConversation.clear();
    this.promptCapByConversation.clear();
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
    const promptCap = this.promptCapByConversation.get(key);
    const promptChars = estimatePromptChars(params, promptCap);

    const used = this.sessionUsageByConversation.get(key) ?? 0;
    const sessionBudget = charBudgetForTokens(
      params.messages,
      SESSION_CONTEXT_BUDGET_TOKENS,
    );
    if (sessionId && used + promptChars > sessionBudget) {
      log(
        `[${this.id}] session context budget reached (${used}+${promptChars} chars) — rolling over`,
      );
      sessionId = undefined;
    }

    if (!sessionId) {
      sessionId = await this.createSession(auth, params.abortSignal);
      this.sessionIdByConversation.set(key, sessionId);
      this.sessionUsageByConversation.set(key, 0);
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
      let answerChars = 0;

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
            maxPromptChars: attempt.maxPromptChars ?? promptCap,
          },
        );

        for await (const chunk of stream) {
          if (chunk.type === "text" || chunk.type === "tool_call") {
            produced = true;
            streamedToUser = true;
          }
          if (chunk.type === "text" || chunk.type === "thinking") {
            answerChars += chunk.content.length;
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

        // The turn now lives in the upstream session and counts against its
        // window, whether or not this conversation chains onto it.
        this.sessionUsageByConversation.set(
          key,
          (this.sessionUsageByConversation.get(key) ?? 0) +
            estimatePromptChars(params, attempt.maxPromptChars ?? promptCap) +
            answerChars,
        );
        // A budget that got through is kept for the rest of the conversation,
        // so the length limit is not rediscovered on every turn.
        if (attempt.maxPromptChars !== undefined) {
          this.promptCapByConversation.set(key, attempt.maxPromptChars);
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
      this.sessionUsageByConversation.set(key, 0);
      this.parentMessageIdByConversation.delete(key);
      return { sessionId: freshSessionId };
    };

    /**
     * Even alone in an empty session the prompt was too long — cut it down.
     * Runs after `freshSession`, so it picks up the session that one created.
     */
    const shrinkPrompt =
      (maxPromptChars: number) => async (): Promise<Attempt> => {
        log(
          `[${this.id}] prompt over the length limit — trimming to ${maxPromptChars} chars`,
        );
        return {
          sessionId: this.sessionIdByConversation.get(key) ?? sessionId,
          maxPromptChars,
        };
      };

    let lastError: unknown;
    try {
      yield* runAttempt.call(this, { sessionId, parentId: parentMessageId });
      return;
    } catch (err) {
      lastError = err;
    }

    const stepsFor = (error: unknown): Array<() => Promise<Attempt>> => {
      // Checked before the slot limit: both mean "come back later", but only
      // this one is counted per account over a window rather than per request.
      if (isRateLimited(error)) {
        const hinted =
          error instanceof RateLimitError && error.retryAfterMs
            ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS)
            : 0;
        return RATE_LIMIT_RETRY_DELAYS_MS.map((ms, i) =>
          waitAndRetry(i === 0 ? Math.max(ms, hinted) : ms, "rate limited"),
        );
      }
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
      // The session is gone — deleted from the DeepSeek UI, or dropped.
      if (isUnknownSession(error)) return [freshSession];
      // The session is full. Dropping the turns it accumulated is enough
      // whenever it held any; past that the prompt itself is over the window
      // and has to be narrowed down.
      if (isContextLimit(error)) {
        // Halve down from what was actually sent, not from a fixed ceiling:
        // a budget at or above the refused size would resend it unchanged.
        const refused = estimatePromptChars(
          params,
          this.promptCapByConversation.get(key),
        );
        const budgets = new Set(
          SHRUNK_PROMPT_FRACTIONS.map((share) =>
            Math.max(MIN_PROMPT_CHARS, Math.floor(refused * share)),
          ).filter((chars) => chars < refused),
        );
        const shrinks = [...budgets].map((chars) => shrinkPrompt(chars));
        return this.sessionUsageByConversation.get(key)
          ? [freshSession, ...shrinks]
          : shrinks;
      }
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

/**
 * The account sent too many turns too quickly. DeepSeek reports it inside the
 * stream — `{"type":"error","finish_reason":"rate_limit_reached"}` — so it
 * arrives as a plain ProviderError, not as an HTTP 429.
 */
function isRateLimited(error: unknown): boolean {
  return (
    error instanceof RateLimitError ||
    (error instanceof Error &&
      /rate_limit_reached|messages too frequent|too many requests/i.test(
        error.message,
      ))
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
 * The session id is not one the account has: deleted from the DeepSeek UI, or
 * dropped upstream. The cached id is dead for good, only a new session helps.
 */
function isUnknownSession(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid chat session|chat session (?:not found|does not exist)|biz error\s*1\b/i.test(
      error.message,
    )
  );
}

/**
 * The turn does not fit. Two upstream wordings, both recovered the same way:
 * "Length limit reached. Please start a new chat." for a session that ran out
 * of room, and "Content is too long. Please shorten it and try again."
 * (`input_exceeds_limit`) for a single prompt over the input window.
 */
function isContextLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    /context_length_exceeded|input_exceeds_limit|length limit reached|content is too long|start a new chat/i.test(
      error.message,
    )
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
    isRateLimited(error) ||
    isExpertBusy(error) ||
    isUnknownSession(error) ||
    isContextLimit(error) ||
    isNetworkFailure(error)
  );
}

/** Roughly what `buildRolePrompt` will send for this request. */
function estimatePromptChars(params: AIRequestParams, cap?: number): number {
  let total = 0;
  for (const message of params.messages) {
    if (message.role === "system") continue;
    total += contentToString(message.content).length;
  }
  return Math.min(
    total,
    cap ?? charBudgetForTokens(params.messages, MAX_PROMPT_TOKENS),
  );
}
