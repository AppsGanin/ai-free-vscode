
// ─── Models ─────────────────────────────────────────────────────────────────

export interface AIModelCapabilities {
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  /** Fit for inline suggestions; `false` hides it from that picker. */
  suggestions?: boolean;
  /** Fit for commit messages; `false` hides it from that picker. */
  commit?: boolean;
  /** Fit for "Fix with AI Free"; `false` hides it from that picker. */
  fix?: boolean;
  /**
   * Fit for chat. `false` drops the model from the VS Code list entirely — and
   * therefore from the other features, which read that same list.
   */
  chat?: boolean;
}

export interface AIModelInfo {
  id: string;
  name: string;
  /** Model family, used for grouping in the picker. */
  family: string;
  version?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: AIModelCapabilities;
}

// ─── Request / response ─────────────────────────────────────────────────────

export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string | AIMessageContentPart[];
  /**
   * Tool calls the assistant made in this turn. Only filled in native mode
   * (see `vsCodeMessageToAI`); web providers read `content` and ignore it.
   */
  toolCalls?: AIToolCall[];
  /** Results this turn carries back for earlier calls. Native mode only. */
  toolResults?: AIToolResult[];
}

export interface AIToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

export interface AIToolResult {
  callId: string;
  content: string;
}

export type AIMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string } };

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIRequestParams {
  model: string;
  messages: AIMessage[];
  /** Upstream chat/session id, to keep context across turns. */
  chatId?: string;
  /** Parent message id, for backends that chain messages. */
  parentId?: string;
  tools?: AIToolDefinition[];
  toolMode?: "auto" | "required" | "none";
  /**
   * Forced thinking mode, overriding the provider default. Service requests
   * (commits, inline suggestions) turn it off — reasoning only adds latency.
   */
  thinkingMode?: "auto" | "on" | "off";
  abortSignal?: AbortSignal;
}

// ─── Stream chunks ──────────────────────────────────────────────────────────

export type AIStreamChunk =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      /** JSON arguments; may arrive in pieces. */
      argumentsPart: string;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number };

// ─── Errors ─────────────────────────────────────────────────────────────────

export class AuthExpiredError extends Error {
  /**
   * @param status HTTP status that carried the refusal, when there was one.
   * Undefined means the backend said so in words (`unauthorized`, 40002, a
   * guest session).
   */
  constructor(
    public readonly providerId: string,
    public readonly status?: number,
  ) {
    super(`Authentication expired for provider: ${providerId}`);
    this.name = "AuthExpiredError";
  }

  /**
   * The server itself refused the credential, so it is dead and must not be
   * sent again. A bare 403 is as often the anti-bot as the session: deleting
   * the sign-in on it would sign the user out for nothing.
   */
  get rejectsCredential(): boolean {
    return this.status !== 403;
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Rate limit exceeded for provider: ${providerId}`);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Aliyun WAF turned the direct server request away, answering with an HTML
 * challenge (usually at status 200) instead of an SSE stream. Signals that the
 * browser path should be used.
 */
export class WafChallengeError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "WafChallengeError";
  }
}
