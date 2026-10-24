import { Emitter, type Disposable, type Event } from "./common/events";
import type { AIModelInfo, AIRequestParams, AIStreamChunk, SecretStore } from "./types";

/**
 * Base class for every AI provider.
 *
 * To add one: create `src/providers/<name>/`, extend this class and register
 * the key in providerConfig.ts + extension.ts.
 */
export abstract class BaseAIProvider implements Disposable {
  /** Unique id; matches the vendor in package.json for the top-level provider. */
  abstract readonly id: string;
  abstract readonly displayName: string;

  /**
   * The backend speaks the OpenAI tools API. Such providers get tool calls and
   * results structured instead of inlined into the transcript; the web
   * backends, which have no tool protocol, leave this off.
   */
  readonly nativeToolCalls: boolean = false;

  protected readonly _onDidAuthChange = new Emitter<void>();
  readonly onDidAuthChange: Event<void> = this._onDidAuthChange.event;

  abstract getModels(): AIModelInfo[];

  /** Same, resolved per model — composite providers look up the sub-provider. */
  supportsNativeToolCalls(_modelId: string): boolean {
    return this.nativeToolCalls;
  }

  /** Models usable right now. Composite providers filter by sub-provider. */
  async getAvailableModels(
    secrets: SecretStore,
  ): Promise<AIModelInfo[]> {
    return (await this.isAuthenticated(secrets)) ? this.getModels() : [];
  }

  /** Must be fast: SecretStorage only, never a network call. */
  abstract isAuthenticated(secrets: SecretStore): Promise<boolean>;

  /** Runs the sign-in flow, stores the result and fires onDidAuthChange. */
  abstract login(secrets: SecretStore): Promise<void>;

  abstract logout(secrets: SecretStore): Promise<void>;

  /** Throws AuthExpiredError / RateLimitError / ProviderError on failure. */
  abstract sendMessageStream(
    params: AIRequestParams,
    secrets: SecretStore,
  ): AsyncIterable<AIStreamChunk>;

  dispose(): void {
    this._onDidAuthChange.dispose();
  }
}
