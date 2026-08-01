import * as vscode from "vscode";
import { createLogger, errToString } from "../../logger";
import { BaseAIProvider } from "../BaseAIProvider";
import { isAbortError, isNetworkFailure } from "../common/http";
import type { AIModelInfo, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError } from "../types";
import {
  listModels,
  streamChatCompletion,
  type RequestContext,
} from "./OpenAICompatApiClient";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  type CustomModelConfig,
  type CustomProviderConfig,
  customProviderId,
  fromCustomModelId,
  secretKey,
  toCustomModelId,
} from "./customConfig";

/** Retries a dropped connection before the error reaches the chat. */
const NETWORK_RETRY_DELAYS_MS = [800, 2500];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Discovered model ids, per endpoint. `getModels()` is synchronous, so the list
 * from `GET /models` has to be readable without awaiting anything — it is kept
 * in the extension's globalState and refreshed in the background.
 *
 * The key carries the base URL, so pointing an endpoint somewhere else drops
 * the models of the old one instead of serving them from a stale entry.
 */
export interface CustomModelCache {
  get(key: string): string[];
  set(key: string, models: string[]): Promise<void>;
}

/** A user-defined endpoint that speaks the OpenAI chat completions API. */
export class OpenAICompatProvider extends BaseAIProvider {
  readonly id: string;
  readonly displayName: string;
  override readonly nativeToolCalls = true;

  private readonly log;
  private refreshing?: Promise<string[]>;

  constructor(
    readonly config: CustomProviderConfig,
    private readonly cache: CustomModelCache,
  ) {
    super();
    this.id = customProviderId(config.id);
    this.displayName = config.name;
    this.log = createLogger(`custom:${config.id}`);
  }

  getModels(): AIModelInfo[] {
    return this.modelConfigs().map((model) => this.toModelInfo(model));
  }

  async isAuthenticated(secrets: vscode.SecretStorage): Promise<boolean> {
    if (this.config.enabled === false) return false;
    if (this.config.noApiKey) return true;
    return !!(await secrets.get(secretKey(this.config.id)));
  }

  async login(secrets: vscode.SecretStorage): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: `${this.displayName} — API key`,
      prompt: `Key for ${this.config.baseUrl}. Leave empty if the endpoint needs none.`,
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;

    await this.setApiKey(secrets, key.trim());
  }

  async logout(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(secretKey(this.config.id));
    this.log.info("api key cleared");
    this._onDidAuthChange.fire();
  }

  /** Stores (or clears) the key and refreshes the model list behind it. */
  async setApiKey(
    secrets: vscode.SecretStorage,
    key: string | undefined,
  ): Promise<void> {
    if (key) {
      await secrets.store(secretKey(this.config.id), key);
      this.log.info("api key stored");
    } else {
      await secrets.delete(secretKey(this.config.id));
      this.log.info("api key cleared");
    }

    this._onDidAuthChange.fire();
    await this.refreshModels(secrets).catch(() => undefined);
  }

  async hasApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
    return !!(await secrets.get(secretKey(this.config.id)));
  }

  /**
   * Asks the endpoint for its models and caches them. A no-op when the user
   * listed the models by hand — that list is meant to win.
   */
  async refreshModels(
    secrets: vscode.SecretStorage,
    signal?: AbortSignal,
  ): Promise<string[]> {
    if (this.config.models?.length) {
      return this.config.models.map((m) => m.id);
    }
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const models = await listModels(await this.context(secrets), signal);
        await this.cache.set(this.cacheKey, models);
        this._onDidAuthChange.fire();
        return models;
      } catch (err) {
        this.log.warn(`model list failed — ${errToString(err)}`);
        throw err;
      } finally {
        this.refreshing = undefined;
      }
    })();

    return this.refreshing;
  }

  /** First-run warm-up: fetch the list only when nothing is known yet. */
  async ensureModels(secrets: vscode.SecretStorage): Promise<void> {
    if (this.config.models?.length) return;
    if (this.cache.get(this.cacheKey).length > 0) return;
    if (!(await this.isAuthenticated(secrets))) return;
    await this.refreshModels(secrets).catch(() => undefined);
  }

  async *sendMessageStream(
    params: AIRequestParams,
    secrets: vscode.SecretStorage,
  ): AsyncIterable<AIStreamChunk> {
    const upstreamModel =
      fromCustomModelId(params.model)?.upstreamId ?? params.model;
    const ctx = await this.context(secrets);

    if (!ctx.apiKey && !this.config.noApiKey) {
      throw new AuthExpiredError(this.id);
    }

    const request: AIRequestParams = { ...params, model: upstreamModel };
    let streamed = false;
    let lastError: unknown;

    for (
      let attempt = 0;
      attempt <= NETWORK_RETRY_DELAYS_MS.length;
      attempt++
    ) {
      if (attempt > 0) {
        this.log.info(
          `connection failed (${errToString(lastError)}) — retrying in ${NETWORK_RETRY_DELAYS_MS[attempt - 1]}ms`,
        );
        await delay(NETWORK_RETRY_DELAYS_MS[attempt - 1]);
      }

      try {
        for await (const chunk of streamChatCompletion(request, ctx)) {
          if (chunk.type === "text" || chunk.type === "tool_call") {
            streamed = true;
          }
          yield chunk;
        }
        return;
      } catch (err) {
        lastError = err;
        // A retry would print the answer twice, and a cancelled request is not
        // a failure at all.
        if (
          streamed ||
          !isNetworkFailure(err) ||
          isAbortError(err, params.abortSignal)
        ) {
          break;
        }
      }
    }

    if (lastError instanceof AuthExpiredError) {
      this._onDidAuthChange.fire();
    }
    if (isAbortError(lastError, params.abortSignal)) return;
    throw lastError;
  }

  /** Discovered models belong to an endpoint address, not just to its name. */
  private get cacheKey(): string {
    return `${this.config.id}@${this.config.baseUrl}`;
  }

  private async context(
    secrets: vscode.SecretStorage,
  ): Promise<RequestContext> {
    return {
      providerId: this.id,
      config: this.config,
      apiKey: await secrets.get(secretKey(this.config.id)),
    };
  }

  /** The manual list when there is one, the discovered list otherwise. */
  private modelConfigs(): CustomModelConfig[] {
    if (this.config.models?.length) return this.config.models;
    return this.cache.get(this.cacheKey).map((id) => ({ id }));
  }

  private toModelInfo(model: CustomModelConfig): AIModelInfo {
    const toolCalling = model.toolCalling ?? this.config.toolCalling !== false;
    const imageInput = model.imageInput ?? this.config.imageInput === true;
    const thinking = model.thinking ?? this.config.thinking === true;

    return {
      id: toCustomModelId(this.config.id, model.id),
      name: model.name?.trim() || model.id,
      family: familyOf(model.id),
      version: "1.0.0",
      maxInputTokens:
        model.maxInputTokens ??
        this.config.maxInputTokens ??
        DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens:
        model.maxOutputTokens ??
        this.config.maxOutputTokens ??
        DEFAULT_MAX_OUTPUT_TOKENS,
      capabilities: {
        toolCalling,
        imageInput,
        thinking,
        streaming: true,
        chat: true,
        commit: true,
        suggestions: true,
        fix: true,
      },
    };
  }
}

/**
 * Grouping label for the picker: the vendor part of an OpenRouter-style id
 * (`qwen/qwen3-coder:free` → `qwen`), or the bare name of a local model
 * (`qwen2.5-coder:7b` → `qwen2.5-coder`).
 */
function familyOf(modelId: string): string {
  const vendor = modelId.includes("/") ? modelId.split("/")[0] : modelId;
  return vendor.split(":")[0] || modelId;
}

/** globalState-backed model cache shared by every custom provider. */
export function createModelCache(memento: vscode.Memento): CustomModelCache {
  const KEY = "freeAI.custom.models";
  const read = (): Record<string, string[]> =>
    memento.get<Record<string, string[]>>(KEY, {});

  return {
    get: (configId) => read()[configId] ?? [],
    set: async (configId, models) => {
      await memento.update(KEY, { ...read(), [configId]: models });
    },
  };
}
