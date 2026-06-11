import { log } from "../../logger";
import { supportsThinking } from "../common/ModelCapabilities";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import {
  buildToolsSystemPrompt,
  createToolCallChunk,
  selectToolsForPrompt,
} from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { QWEN_MODELS, resolveModelId, toQwenApiModelType } from "./QwenModels";

const QWEN_CHAT_API_URL = "https://chat.qwen.ai/api/v2/chat/completions";
const QWEN_CREATE_CHAT_URL = "https://chat.qwen.ai/api/v2/chats/new";
const QWEN_STOP_CHAT_URL = "https://chat.qwen.ai/api/v2/chat/completions/stop";
const PROVIDER_ID = "ai-free-vscode";

const MAX_PROMPT_CHARS = 500000;
const MAX_SYSTEM_MESSAGE_CHARS = 100000;
const MAX_TOOLMODE_NO_TOOLCALL_MS = 20000;
const MAX_TOOLMODE_NO_TOOLCALL_CHARS = 12000;
const MIN_TOOLMODE_GUARD_TEXT_CHARS = 64;

const CHAT_IN_PROGRESS_RETRY_DELAYS_MS = [
  500, 1000, 2000, 4000, 7500, 10000, 15000,
];

interface QwenRequestBody {
  stream: boolean;
  incremental_output: boolean;
  chat_id: string;
  chat_mode: "normal";
  messages: Array<Record<string, unknown>>;
  model: string;
  parent_id?: string;
  system_message?: string;
  timestamp?: number;
}

interface QwenContentPart {
  type: "text" | "image";
  text?: string;
  image?: string;
}

interface QwenStreamDelta {
  role?: string;
  phase?: "think" | "answer" | string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface QwenStreamChoice {
  index: number;
  delta: QwenStreamDelta;
  finish_reason: string | null;
}

interface QwenStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: QwenStreamChoice[];
  chat_id?: string;
  parent_id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: unknown;
  details?: unknown;
}

function stringifyUnknown(value: unknown, maxLen = 600): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.message || value.name;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const nestedMessage = obj.message;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage;
    }

    try {
      const serialized = JSON.stringify(value);
      return serialized.length > maxLen
        ? `${serialized.slice(0, maxLen)}…`
        : serialized;
    } catch {
      return String(value);
    }
  }

  return String(value);
}

export class QwenApiClient {
  async *sendMessageStream(
    params: AIRequestParams,
    token: string,
  ): AsyncIterable<AIStreamChunk> {
    const normalizedToken = this.normalizeToken(token);
    const resolvedModelId = resolveModelId(params.model);
    const apiModelType = toQwenApiModelType(resolvedModelId);
    let chatId = params.chatId;

    if (!chatId) {
      chatId = await this.createChat(normalizedToken, apiModelType);
      if (!chatId) {
        throw new ProviderError(
          PROVIDER_ID,
          "Failed to create chat_id in Qwen API",
        );
      }
      log(`[qwen-api] created chat_id=${chatId}`);
    }

    const allowToolCalls = params.toolMode !== "none";
    const hasTools = allowToolCalls && (params.tools?.length ?? 0) > 0;

    const { messageContent, systemMessage } = this.extractRequestParts(
      params.messages,
    );

    const body: QwenRequestBody = this.buildQwenPayload({
      model: apiModelType,
      chatId,
      parentId: params.parentId,
      messageContent,
      systemMessage,
      hasTools,
      thinkingMode: params.thinkingMode,
    });

    if (params.parentId) {
      body.parent_id = params.parentId;
    }

    if (allowToolCalls && params.tools?.length) {
      const selectedTools = selectToolsForPrompt(
        params.tools,
        messageContent,
        params.toolMode,
      );
      const toolsPrompt = buildToolsSystemPrompt(selectedTools);

      body.system_message = body.system_message
        ? `${body.system_message}\n\n${toolsPrompt}`
        : toolsPrompt;

      log(
        `[qwen-api] injected ${selectedTools.length}/${params.tools.length} tools into system_message toolsPromptLen=${toolsPrompt.length}`,
      );
    }

    log(
      `[qwen-api] POST model=${apiModelType} messages=${params.messages.length} chat_id=${chatId}`,
    );

    const requestUrlFor = (currentChatId: string) =>
      `${QWEN_CHAT_API_URL}?chat_id=${encodeURIComponent(currentChatId)}`;

    let response: Response | undefined;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    const sendOnce = async function* (
      this: QwenApiClient,
      currentBody: QwenRequestBody,
      currentChatId: string,
    ): AsyncIterable<AIStreamChunk> {
      response = await this.fetchChatCompletions({
        requestUrl: requestUrlFor(currentChatId),
        token: normalizedToken,
        chatId: currentChatId,
        body: currentBody,
        abortSignal: params.abortSignal,
      });
      yield* this.parseSSEText(response, allowToolCalls);
    };

    try {
      yield* sendOnce.call(this, body, chatId);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const isAbort =
        !!params.abortSignal?.aborted ||
        error instanceof DOMException ||
        /aborted|aborterror|request aborted/i.test(msg);
      const isInternal = /internal error/i.test(msg);
      const isChatInProgress = /chat is in progress/i.test(msg);
      const isNetworkTerminated = /^terminated$/i.test(msg.trim());

      if (isAbort) {
        // По отмене в VS Code пытаемся остановить активный апстрим на сервере,
        // иначе следующий запрос в тот же chat_id может получить
        // "The chat is in progress!".
        await this.stopStream(normalizedToken, chatId).catch(() => undefined);
        throw error;
      }

      if (isChatInProgress) {
        log(
          "[qwen-api] upstream reports chat in progress, will stop and retry in same chat_id with backoff",
        );

        let lastError: unknown = error;
        const retryDelays = CHAT_IN_PROGRESS_RETRY_DELAYS_MS;

        for (let attempt = 0; attempt < retryDelays.length; attempt++) {
          await this.stopStream(normalizedToken, chatId).catch((stopErr) => {
            log(
              `[qwen-api] stop stream failed before retry #${attempt + 1}: ${String(stopErr)}`,
            );
          });

          const delayMs = retryDelays[attempt];
          if (delayMs > 0) {
            log(
              `[qwen-api] waiting ${delayMs}ms before retry #${attempt + 1} in chat_id=${chatId}`,
            );
            await sleep(delayMs);
          }

          try {
            yield* sendOnce.call(this, body, chatId);
            return;
          } catch (retryError) {
            lastError = retryError;
            const retryMsg =
              retryError instanceof Error
                ? retryError.message
                : String(retryError);
            if (!/chat is in progress/i.test(retryMsg)) {
              throw retryError;
            }

            log(
              `[qwen-api] retry #${attempt + 1} still reports chat in progress`,
            );
          }
        }

        throw lastError;
      }

      if (isNetworkTerminated && !params.abortSignal?.aborted) {
        log(
          "[qwen-api] network terminated during stream (TLS drop), retrying with new chat_id",
        );
        const newChatId = await this.createChat(normalizedToken, apiModelType);
        if (!newChatId) {
          throw new ProviderError(
            PROVIDER_ID,
            "Connection dropped; failed to create a new chat for retry",
          );
        }
        const retryBody: QwenRequestBody = {
          ...body,
          chat_id: newChatId,
        };
        yield* sendOnce.call(this, retryBody, newChatId);
        return;
      }

      if (isInternal) {
        log(
          "[qwen-api] upstream internal error, retrying in a NEW chat with original payload",
        );

        const freshChatId = await this.createChat(
          normalizedToken,
          apiModelType,
        );
        if (!freshChatId) {
          throw new ProviderError(
            PROVIDER_ID,
            "Qwen internal_error: failed to create a new chat for retry",
          );
        }

        const retryBody = this.buildFreshChatRetryBody(body, freshChatId);
        yield* sendOnce.call(this, retryBody, freshChatId);
        return;
      }

      throw error;
    }
  }

  private buildFreshChatRetryBody(
    body: QwenRequestBody,
    newChatId: string,
  ): QwenRequestBody {
    const nextMessages = body.messages.map((msg, index) => {
      if (index > 0) {
        return { ...msg };
      }

      const cloned: Record<string, unknown> = { ...msg };
      delete cloned.parentId;
      delete cloned.parent_id;
      return cloned;
    });

    return {
      ...body,
      chat_id: newChatId,
      parent_id: undefined,
      messages: nextMessages,
      system_message: body.system_message,
      timestamp: Date.now(),
    };
  }

  private async fetchChatCompletions(params: {
    requestUrl: string;
    token: string;
    chatId: string;
    body: QwenRequestBody;
    abortSignal?: AbortSignal;
  }): Promise<Response> {
    const response = await fetch(params.requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://chat.qwen.ai/c/${params.chatId}`,
        Origin: "https://chat.qwen.ai",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(params.body),
      signal: params.abortSignal,
    });

    log(`[qwen-api] response status=${response.status}`);

    if (response.status === 401) {
      throw new AuthExpiredError(PROVIDER_ID);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(
        PROVIDER_ID,
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
      );
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const errBody = await response.text();
        message += `: ${errBody.slice(0, 200)}`;
      } catch {
        // ignore
      }
      throw new ProviderError(PROVIDER_ID, message, response.status);
    }

    if (!response.body) {
      throw new ProviderError(PROVIDER_ID, "Response body is empty");
    }

    return response;
  }

  async createChat(token: string, model: string): Promise<string | undefined> {
    const response = await fetch(QWEN_CREATE_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://chat.qwen.ai",
        Referer: "https://chat.qwen.ai/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        title: "New chat",
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: Date.now(),
      }),
    });

    const bodyText = await response.text().catch(() => "");

    if (!response.ok) {
      log(
        `[qwen-api] createChat failed status=${response.status} body=${bodyText.slice(0, 300)}`,
      );
      return undefined;
    }

    let data: { data?: { id?: string; chat_id?: string }; id?: string } = {};
    try {
      data = JSON.parse(bodyText);
    } catch {
      log(`[qwen-api] createChat ok but response is not JSON: ${bodyText.slice(0, 200)}`);
      return undefined;
    }

    const chatId = data?.data?.id ?? data?.data?.chat_id ?? data?.id;
    if (!chatId) {
      log(`[qwen-api] createChat ok but no id in response: ${bodyText.slice(0, 300)}`);
    }
    return chatId;
  }

  private async stopStream(token: string, chatId: string): Promise<void> {
    const requestUrl = `${QWEN_STOP_CHAT_URL}?chat_id=${encodeURIComponent(chatId)}`;
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Requested-With": "XMLHttpRequest",
        Referer: `https://chat.qwen.ai/c/${chatId}`,
        Origin: "https://chat.qwen.ai",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ chat_id: chatId }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new ProviderError(
        PROVIDER_ID,
        `stop_stream failed HTTP ${response.status}: ${errText.slice(0, 200)}`,
        response.status,
      );
    }

    log(`[qwen-api] stop_stream ok chat_id=${chatId}`);
  }

  private extractRequestParts(messages: AIMessage[]): {
    messageContent: string | QwenContentPart[];
    systemMessage?: string;
  } {
    const systems = messages.filter((m) => m.role === "system");
    const languageGuard =
      "Always answer in the same language as the latest user message.";

    const prompt = this.buildPromptFromMessages(messages);
    const messageContent = this.resolveQwenMessageContent(messages, prompt);

    const rawSystem =
      systems
        .map((m) => this.contentToString(m.content))
        .filter(Boolean)
        .join("\n\n") || "";

    const systemMessage = [languageGuard, rawSystem]
      .filter(Boolean)
      .join("\n\n");

    const boundedSystemMessage = systemMessage
      ? systemMessage.slice(0, MAX_SYSTEM_MESSAGE_CHARS)
      : undefined;

    if (boundedSystemMessage) {
      log(`[qwen-api] system_message length=${boundedSystemMessage.length}`);
    }

    log(`[qwen-api] prompt length=${prompt.length}`);

    return { messageContent, systemMessage: boundedSystemMessage };
  }

  private resolveQwenMessageContent(
    messages: AIMessage[],
    prompt: string,
  ): string | QwenContentPart[] {
    const latestUserMessage = [...messages]
      .reverse()
      .find((m) => m.role === "user");

    if (!latestUserMessage || typeof latestUserMessage.content === "string") {
      return prompt;
    }

    const imageParts = latestUserMessage.content
      .filter(
        (part): part is { type: "image_url"; imageUrl: { url: string } } => {
          return part.type === "image_url" && !!part.imageUrl?.url;
        },
      )
      .map((part) => ({
        type: "image" as const,
        image: part.imageUrl.url,
      }));

    if (imageParts.length === 0) {
      return prompt;
    }

    const sourceKinds = imageParts
      .map((p) => this.describeImageSource(p.image ?? ""))
      .slice(0, 4)
      .join(", ");

    log(
      `[qwen-api] attaching ${imageParts.length} image(s) from latest user message sources=${sourceKinds}`,
    );

    return [{ type: "text", text: prompt }, ...imageParts];
  }

  private describeImageSource(url: string): string {
    const raw = url.trim().toLowerCase();
    if (raw.startsWith("data:")) {
      const mime = raw.slice(5).split(";")[0] ?? "unknown";
      return `data:${mime}`;
    }
    if (raw.startsWith("https://")) return "https";
    if (raw.startsWith("http://")) return "http";
    if (raw.startsWith("file:")) return "file";
    if (raw.startsWith("blob:")) return "blob";
    return "other";
  }

  private buildPromptFromMessages(messages: AIMessage[]): string {
    const rawParts: string[] = [];

    for (const m of messages) {
      if (m.role === "system") continue;

      const content = this.contentToString(m.content).trim();
      if (!content) continue;

      const roleLabel = m.role === "assistant" ? "Assistant" : "User";
      rawParts.push(`${roleLabel}: ${content}`);
    }

    if (rawParts.length === 0) {
      return "Assistant:";
    }

    const suffix = "\n\nAssistant:";
    const parts: string[] = [];
    let total = suffix.length;

    for (let i = rawParts.length - 1; i >= 0; i--) {
      const part = rawParts[i];
      const addition = part.length + (parts.length > 0 ? 2 : 0);

      if (total + addition > MAX_PROMPT_CHARS) {
        if (parts.length === 0) {
          const available = Math.max(128, MAX_PROMPT_CHARS - total);
          parts.unshift(part.slice(-available));
          total += Math.min(part.length, available);
        }
        break;
      }

      parts.unshift(part);
      total += addition;
    }

    const dropped = rawParts.length - parts.length;
    if (dropped > 0) {
      log(
        `[qwen-api] prompt trimmed droppedParts=${dropped} maxChars=${MAX_PROMPT_CHARS}`,
      );
    }

    parts.push("Assistant:");
    return parts.join("\n\n");
  }

  private contentToString(content: AIMessage["content"]): string {
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((part) => (part.type === "text" ? part.text : "[image]"))
      .join("\n");
  }

  private normalizeMessageContent(
    content: AIMessage["content"],
  ): string | QwenContentPart[] {
    if (typeof content === "string") {
      return content;
    }

    return content.map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      return { type: "image" as const, image: part.imageUrl.url };
    });
  }

  private buildQwenPayload(params: {
    model: string;
    chatId: string;
    parentId?: string;
    messageContent: string | QwenContentPart[];
    systemMessage?: string;
    hasTools?: boolean;
    thinkingMode?: "auto" | "on" | "off";
  }): QwenRequestBody {
    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    const thinkingConfig = this.resolveThinkingConfig(
      params.model,
      Boolean(params.hasTools),
      params.thinkingMode,
    );

    const message = {
      fid: userMsgId,
      parentId: params.parentId,
      parent_id: params.parentId,
      role: "user",
      content: params.messageContent,
      chat_type: "t2t",
      sub_chat_type: "t2t",
      timestamp: Math.floor(Date.now() / 1000),
      user_action: "chat",
      models: [params.model],
      files: [],
      childrenIds: [assistantMsgId],
      extra: { meta: { subChatType: "t2t" } },
      feature_config: {
        thinking_enabled: thinkingConfig.enabled,
        ...(thinkingConfig.enabled
          ? { thinking_budget_tokens: thinkingConfig.budgetTokens }
          : {}),
        ...(thinkingConfig.enabled ? { output_schema: "phase" } : {}),
      },
    };

    log(
      `[qwen-api] feature_config thinking_mode=${thinkingConfig.mode} thinking_enabled=${thinkingConfig.enabled} budget=${thinkingConfig.budgetTokens} hasTools=${Boolean(params.hasTools)}`,
    );

    return {
      stream: true,
      incremental_output: true,
      chat_id: params.chatId,
      chat_mode: "normal",
      messages: [message],
      model: params.model,
      parent_id: params.parentId,
      timestamp: Date.now(),
      system_message: params.systemMessage,
    };
  }

  private resolveThinkingConfig(
    model: string,
    hasTools: boolean,
    override?: "auto" | "on" | "off",
  ): {
    mode: "auto" | "on" | "off";
    enabled: boolean;
    budgetTokens: number;
  } {
    // Режим всегда "auto" (настройка убрана); override "off" приходит только от
    // служебных запросов (коммиты/фиксы/inline-подсказки).
    const mode: "auto" | "on" | "off" = override === "off" ? "off" : "auto";

    const budgetTokens = 4096;

    const thinkingSupported = supportsThinking(
      QWEN_MODELS,
      resolveModelId(model),
    );
    // При наличии tools thinking выключаем всегда: связка reasoning + инструменты
    // на этом бэкенде ненадёжна. В обычном чате (без tools) — включён.
    const enabled = thinkingSupported && !hasTools && mode !== "off";

    return { mode, enabled, budgetTokens };
  }

  private async *parseSSEText(
    response: Response,
    allowToolCalls: boolean,
  ): AsyncIterable<AIStreamChunk> {
    const body = response.body;
    if (!body) {
      throw new ProviderError(PROVIDER_ID, "Response body is empty");
    }

    let fullText = "";
    const nativeToolCalls: AIStreamChunk[] = [];
    let chunkCount = 0;
    let lastPromptTokens = 0;
    let lastCompletionTokens = 0;
    let streamedTextChars = 0;

    // Маршрутизатор текстового канала: скользящим окном ловит ```tool_call```
    // маркеры в стриме и придерживает потенциальный вызов до конца.
    const router = new StreamingToolCallRouter(
      allowToolCalls,
      log,
      "[qwen-api] ",
    );

    let sseRawLength = 0;
    let sseLineCount = 0;
    const firstLines: string[] = [];
    let phaseDebugCount = 0;
    const PHASE_DEBUG_LIMIT = 200;

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let firstAnswerAt: number | undefined;
    let lastChunkAt = Date.now();
    let idleWarnLevel = 0;
    let stoppedByGuard = false;

    const maybeLogIdle = () => {
      const idleMs = Date.now() - lastChunkAt;
      const thresholds = [5000, 15000, 30000];
      while (
        idleWarnLevel < thresholds.length &&
        idleMs >= thresholds[idleWarnLevel]
      ) {
        const sec = Math.floor(idleMs / 1000);
        log(
          `[qwen-api] SSE idle ${sec}s (no new bytes) fullTextLength=${fullText.length} chunkCount=${chunkCount}`,
        );
        idleWarnLevel++;
      }
    };

    const processParsed = function* (
      parsed: QwenStreamChunk,
    ): Iterable<AIStreamChunk> {
      if (parsed.error) {
        const errText = stringifyUnknown(parsed.error);
        const detailsText = stringifyUnknown(parsed.details);
        const combined = detailsText
          ? `${errText || "Qwen API error"}: ${detailsText}`
          : errText || "Qwen API error";

        // Если контент уже начал стримиться — это инфраструктурный обрыв Qwen
        // в конце потока, а не реальная ошибка. Завершаем стрим gracefully.
        if (fullText.length > 0 || streamedTextChars > 0) {
          log(
            `[qwen-api] internal_error mid-stream after ${fullText.length} chars — treating as stream end: ${combined}`,
          );
          return;
        }

        throw new ProviderError(PROVIDER_ID, combined);
      }

      if (parsed.usage) {
        const prompt = parsed.usage.prompt_tokens ?? parsed.usage.input_tokens;
        const completion =
          parsed.usage.completion_tokens ?? parsed.usage.output_tokens;
        if (typeof prompt === "number" && Number.isFinite(prompt)) {
          lastPromptTokens = prompt;
        }
        if (typeof completion === "number" && Number.isFinite(completion)) {
          lastCompletionTokens = completion;
        }
      }

      for (const choice of parsed.choices ?? []) {
        const delta = choice.delta;
        if (!delta) continue;

        const phase = String(delta.phase ?? "answer").toLowerCase();
        const rawContent = delta.content ?? "";
        // У Qwen thinking может приходить либо в reasoning_content,
        // либо в content + phase=think.
        const thinkingText =
          (delta.reasoning_content ?? "") +
          (phase === "think" ? rawContent : "");
        const contentText = phase === "think" ? "" : rawContent;

        if (phaseDebugCount < PHASE_DEBUG_LIMIT) {
          const toolCallsCount = Array.isArray(delta.tool_calls)
            ? delta.tool_calls.length
            : 0;
          log(
            `[qwen-api] phase=${phase} thinkingLen=${thinkingText.length} contentLen=${contentText.length} rawLen=${rawContent.length} toolCallsInDelta=${toolCallsCount}`,
          );
          phaseDebugCount++;
        }

        if (thinkingText) {
          // Thinking всегда стримим немедленно отдельным типом
          yield { type: "thinking", content: thinkingText };
        }

        if (contentText) {
          if (firstAnswerAt === undefined) {
            firstAnswerAt = Date.now();
          }
          fullText += contentText;

          // Текстовый канал маршрутизируем через общий роутер: он же содержит
          // транскрипт-страж (обрезает фейковый следующий ход) и ловит/придерживает
          // ```tool_call``` маркеры. Нативные tool_calls обрабатываются ниже.
          for (const chunk of router.route(contentText)) {
            if (chunk.type === "text") {
              streamedTextChars += chunk.content.length;
            }
            yield chunk;
          }
        }

        for (const toolCall of delta.tool_calls ?? []) {
          chunkCount++;
          nativeToolCalls.push(
            createToolCallChunk({
              callId: toolCall.id || `call_${toolCall.index}`,
              name: toolCall.function?.name ?? "",
              argumentsPart: toolCall.function?.arguments ?? "",
            }),
          );
        }
      }
    };

    const processLine = function* (line: string): Iterable<AIStreamChunk> {
      sseRawLength += line.length + 1;
      sseLineCount++;
      if (firstLines.length < 3) {
        firstLines.push(line);
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") {
        return;
      }
      if (!trimmed.startsWith("data: ")) {
        // Иногда upstream возвращает не SSE, а JSON-объект в одной строке
        // (в т.ч. success:false при status=200). Такое нельзя проглатывать.
        if (trimmed.startsWith("{")) {
          try {
            const json = JSON.parse(trimmed) as {
              success?: boolean;
              request_id?: string;
              data?: { code?: string; details?: unknown };
            };
            if (json.success === false) {
              const code = json.data?.code ?? "Bad_Request";
              const details =
                typeof json.data?.details === "string"
                  ? json.data.details
                  : JSON.stringify(json.data?.details ?? "");
              throw new ProviderError(PROVIDER_ID, `${code}: ${details}`);
            }
          } catch (e) {
            // Если это именно ProviderError — пробрасываем выше
            if (e instanceof ProviderError) {
              throw e;
            }
          }
        }
        return;
      }

      const jsonStr = trimmed.slice("data: ".length);
      let parsed: QwenStreamChunk;
      try {
        parsed = JSON.parse(jsonStr) as QwenStreamChunk;
      } catch (e) {
        log(
          `[qwen-api] JSON parse error: ${e} | raw: ${jsonStr.slice(0, 100)}`,
        );
        return;
      }

      yield* processParsed(parsed);
    };

    while (true) {
      maybeLogIdle();
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      if (value?.length) {
        lastChunkAt = Date.now();
        idleWarnLevel = 0;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        yield* processLine(line);
      }

      if (router.cut) {
        stoppedByGuard = true;
        log(
          "[qwen-api] transcript boundary detected (fabricated User/Tool-result turn) — stopping stream",
        );
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }

      if (
        allowToolCalls &&
        nativeToolCalls.length === 0 &&
        fullText.length > 0 &&
        !router.holding
      ) {
        const elapsedSinceAnswerMs =
          firstAnswerAt !== undefined ? Date.now() - firstAnswerAt : 0;
        const stopByTime =
          firstAnswerAt !== undefined &&
          fullText.length >= MIN_TOOLMODE_GUARD_TEXT_CHARS &&
          elapsedSinceAnswerMs >= MAX_TOOLMODE_NO_TOOLCALL_MS;
        const stopBySize = fullText.length >= MAX_TOOLMODE_NO_TOOLCALL_CHARS;

        if (stopByTime || stopBySize) {
          stoppedByGuard = true;
          log(
            `[qwen-api] stream guard stop: no tool_call elapsedSinceAnswerMs=${elapsedSinceAnswerMs} fullTextLength=${fullText.length}`,
          );

          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          break;
        }
      }
    }

    if (buffer.trim()) {
      yield* processLine(buffer);
    }

    log(`[qwen-api] SSE text length=${sseRawLength} lines=${sseLineCount}`);
    for (let i = 0; i < firstLines.length; i++) {
      log(`[qwen-api] line[${i}]: ${firstLines[i].slice(0, 200)}`);
    }

    let emittedAnything = streamedTextChars > 0;

    if (allowToolCalls && nativeToolCalls.length > 0) {
      // Нативные tool_calls имеют приоритет; удержанный текст не превращаем в
      // дублирующий вызов — отдаём его как обычный текст.
      log(`[qwen-api] native toolCalls=${nativeToolCalls.length}`);
      for (const chunk of router.finishAsText()) {
        if (chunk.type === "text") {
          streamedTextChars += chunk.content.length;
        }
        yield chunk;
      }
      yield* nativeToolCalls;
      emittedAnything = true;
    } else {
      // Парсим удержанный текст в tool_call либо отдаём как текст (роутер
      // корректно работает и без инструментов — там хвост уйдёт как текст).
      for (const chunk of router.finish()) {
        if (chunk.type === "text") {
          streamedTextChars += chunk.content.length;
        }
        yield chunk;
        emittedAnything = true;
      }
    }

    // Гарантированный фолбэк: если пользователю не отдали ничего (ни текста,
    // ни tool call), но модель что-то сгенерировала — отдаём накопленный текст,
    // чтобы исключить пустой ответ. НО не после обрыва на фейковой границе:
    // там fullText содержит галлюцинированный транскрипт, который мы и срезали.
    if (!emittedAnything && !router.cut && fullText.trim()) {
      yield { type: "text", content: fullText };
    }

    if (lastPromptTokens > 0 || lastCompletionTokens > 0) {
      yield {
        type: "usage",
        promptTokens: lastPromptTokens,
        completionTokens: lastCompletionTokens,
      };
      log(
        `[qwen-api] usage prompt_tokens=${lastPromptTokens} completion_tokens=${lastCompletionTokens}`,
      );
    }

    log(
      `[qwen-api] SSE parsed chunkCount=${chunkCount} fullTextLength=${fullText.length}`,
    );

    if (stoppedByGuard) {
      log("[qwen-api] SSE finished by stream guard");
    }
  }

  private normalizeToken(token: string): string {
    let t = token.trim();
    if (/^Bearer\s+/i.test(t)) {
      t = t.replace(/^Bearer\s+/i, "").trim();
    }
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      t = t.slice(1, -1).trim();
    }
    return t;
  }
}
