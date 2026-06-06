import { createLogger } from "../../logger";
import { supportsThinking } from "../common/ModelCapabilities";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import {
  buildToolsSystemPrompt,
  selectToolsForPrompt,
} from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { KIMI_MODELS, resolveKimiModelId } from "./KimiModels";

const PROVIDER_ID = "ai-free-vscode-kimi";
const BASE_URL = "https://www.kimi.com";
const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const SCENARIO = "SCENARIO_K2D5";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const STREAM_TIMEOUT_MS = 120000;

const log = createLogger("kimi-api");

export interface KimiAuthState {
  token: string;
}

interface KimiFrameMessage {
  error?: { message?: string; code?: string } | string;
  heartbeat?: unknown;
  op?: string;
  done?: unknown;
  mask?: string;
  block?: {
    id?: string;
    type?: string;
    text?: { content?: string };
    thinking?: { content?: string };
    tool?: {
      toolCallId?: string;
      name?: string;
      args?: string;
      status?: string;
    };
    [key: string]: unknown;
  };
  chat?: { id?: string };
  message?: { id?: string; role?: string };
  [key: string]: unknown;
}

export class KimiApiClient {
  async *sendMessageStream(
    params: AIRequestParams,
    auth: KimiAuthState,
  ): AsyncIterable<AIStreamChunk> {
    const token = auth.token;
    const resolvedModelId = resolveKimiModelId(params.model);

    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;

    const thinkingConfig = this.resolveThinkingConfig(
      resolvedModelId,
      hasTools,
      params.thinkingMode,
    );

    let toolsPrompt = "";
    if (hasTools && params.tools?.length) {
      const selectedTools = selectToolsForPrompt(
        params.tools,
        this.lastUserText(params.messages),
        params.toolMode,
      );
      toolsPrompt = buildToolsSystemPrompt(selectedTools);
    }

    const content = this.buildContent(params.messages, toolsPrompt);

    const requestBody = {
      scenario: SCENARIO,
      chat_id: "",
      tools: [] as unknown[],
      message: {
        parent_id: "",
        role: "user",
        blocks: [{ message_id: "", text: { content } }],
        scenario: SCENARIO,
      },
      options: { thinking: thinkingConfig.enabled },
    };

    const frame = this.encodeFrame(JSON.stringify(requestBody));

    log.info(
      `request model=${resolvedModelId} thinking=${thinkingConfig.enabled} hasTools=${hasTools} contentChars=${content.length}`,
    );

    const response = await fetch(`${BASE_URL}${CHAT_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/connect+json",
        "Connect-Protocol-Version": "1",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/`,
        "User-Agent": USER_AGENT,
        "X-Msh-Platform": "web",
      },
      body: frame,
      signal: params.abortSignal,
    });

    log.debug(`response status=${response.status}`);

    if (response.status === 401 || response.status === 403) {
      log.warn(`auth expired (status=${response.status})`);
      throw new AuthExpiredError(PROVIDER_ID);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      log.warn(`rate limited (retry-after=${retryAfter ?? "n/a"})`);
      throw new RateLimitError(
        PROVIDER_ID,
        retryAfter ? Number(retryAfter) * 1000 : undefined,
      );
    }
    if (!response.ok || !response.body) {
      const txt = await response.text().catch(() => "");
      log.error(`request failed HTTP ${response.status}: ${txt.slice(0, 220)}`);
      throw new ProviderError(
        PROVIDER_ID,
        `HTTP ${response.status}: ${txt.slice(0, 220)}`,
        response.status,
      );
    }

    yield* this.parseFrames(response.body, allowToolCalls, params.abortSignal);
  }

  private async *parseFrames(
    body: ReadableStream<Uint8Array>,
    allowToolCalls: boolean,
    abortSignal?: AbortSignal,
  ): AsyncIterable<AIStreamChunk> {
    const router = new StreamingToolCallRouter(
      allowToolCalls,
      (m) => log.debug(m),
      "",
    );
    const reader = body.getReader();
    let buffer = Buffer.alloc(0);
    let done = false;
    let textChars = 0;
    let thinkingChars = 0;
    // Диагностика: считаем фреймы по op и логируем первые несколько целиком,
    // чтобы видеть структуру, которую Kimi реально присылает.
    let frameCount = 0;
    let loggedFrames = 0;
    let unhandledFrames = 0;
    let nativeToolCalls = 0;
    const opCounts = new Map<string, number>();

    const handleMessage = function* (
      this: KimiApiClient,
      msg: KimiFrameMessage,
    ): Iterable<AIStreamChunk> {
      frameCount++;
      const op =
        msg.op ??
        (msg.done !== undefined
          ? "(done)"
          : msg.heartbeat
            ? "(heartbeat)"
            : msg.error
              ? "(error)"
              : "(none)");
      opCounts.set(op, (opCounts.get(op) ?? 0) + 1);

      if (loggedFrames < 30) {
        loggedFrames++;
        const blockKeys = msg.block ? Object.keys(msg.block).join(",") : "-";
        const blockType = msg.block?.type ?? "-";
        const textLen = msg.block?.text?.content?.length ?? 0;
        log.debug(
          `frame#${frameCount} op=${op} keys=[${Object.keys(msg).join(",")}] block.type=${blockType} block.keys=[${blockKeys}] textLen=${textLen}`,
        );
      }

      if (msg.error) {
        const text =
          typeof msg.error === "string"
            ? msg.error
            : (msg.error.message ?? msg.error.code ?? "Kimi API error");
        throw new ProviderError(PROVIDER_ID, `Kimi error: ${text}`);
      }
      if (msg.heartbeat) {
        return;
      }

      // Нативный вызов встроенного code-interpreter Kimi (block.tool/ipython).
      // Kimi исполняет его на своей стороне и сам продолжает генерацию, поэтому
      // мы просто ждём итоговый текст. Фреймы tool.args тут «гасим», чтобы они не
      // засоряли счётчик unhandled; считаем вызовы только для диагностики.
      if (msg.block?.tool) {
        if (msg.op === "set") {
          nativeToolCalls++;
        }
        return;
      }

      const handledBefore = textChars + thinkingChars;

      const thinking = msg.block?.thinking?.content;
      if (
        thinking &&
        (msg.op === "append" || msg.op === "set")
      ) {
        thinkingChars += thinking.length;
        yield { type: "thinking", content: thinking };
      }

      const textContent = msg.block?.text?.content;
      const isThinkBlock = msg.block?.type
        ? /think|reason/i.test(msg.block.type)
        : false;
      if (textContent && (msg.op === "append" || msg.op === "set")) {
        if (isThinkBlock) {
          thinkingChars += textContent.length;
          yield { type: "thinking", content: textContent };
        } else {
          textChars += textContent.length;
          yield* router.route(textContent);
        }
      }

      if (msg.done !== undefined) {
        done = true;
        return;
      }

      // Фрейм нёс данные (не heartbeat/done/chat/message), но контент не извлечён —
      // признак того, что Kimi кладёт ответ в незнакомую нам структуру.
      const carriesData =
        !!msg.block || (msg.op !== undefined && !msg.chat && !msg.message);
      if (carriesData && textChars + thinkingChars === handledBefore) {
        unhandledFrames++;
        if (unhandledFrames <= 5) {
          log.debug(
            `unhandled frame#${frameCount}: ${JSON.stringify(msg).slice(0, 400)}`,
          );
        }
      }
    };

    // reader.read() может зависнуть навсегда, если сервер держит соединение
    // открытым и не шлёт данных. Проверка таймаута в начале цикла тогда не
    // срабатывает (она выполняется только после возврата read), поэтому гоняем
    // read с собственным таймаутом.
    const readWithTimeout = async (): Promise<
      ReadableStreamReadResult<Uint8Array>
    > => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(PROVIDER_ID, "Kimi stream timeout")),
          STREAM_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };

    try {
      while (!done) {
        const { done: streamDone, value } = await readWithTimeout();
        if (streamDone) {
          break;
        }
        if (value?.length) {
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
        }

        let offset = 0;
        while (offset + 5 <= buffer.length) {
          const length = buffer.readUInt32BE(offset + 1);
          if (offset + 5 + length > buffer.length) {
            break;
          }
          const payload = buffer.subarray(offset + 5, offset + 5 + length);
          offset += 5 + length;

          const text = payload.toString("utf8").trim();
          if (text) {
            let parsed: KimiFrameMessage | undefined;
            try {
              parsed = JSON.parse(text) as KimiFrameMessage;
            } catch {
              parsed = undefined;
            }
            if (parsed) {
              yield* handleMessage.call(this, parsed);
            }
          }
          // Транскрипт-страж в роутере распознал фейковый следующий ход —
          // прекращаем чтение (reader.cancel в finally закроет соединение).
          if (router.cut) {
            log.debug("transcript boundary detected — stopping stream");
            done = true;
          }
          if (done) {
            break;
          }
        }
        buffer = buffer.subarray(offset);
      }
    } catch (err) {
      const aborted =
        !!abortSignal?.aborted ||
        err instanceof DOMException ||
        (err instanceof Error && /abort/i.test(err.message));
      if (!aborted) {
        log.error(
          `stream error: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      log.debug("stream aborted by caller");
    } finally {
      // cancel() закрывает нижележащее соединение — важно при раннем обрыве
      // (native loop / timeout), иначе fetch-стрим может остаться висеть.
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }

    yield* router.finish();

    const opSummary = [...opCounts.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    log.info(
      `stream done textChars=${textChars} thinkingChars=${thinkingChars} frames=${frameCount} unhandled=${unhandledFrames} nativeToolCalls=${nativeToolCalls} ops=[${opSummary}]`,
    );
    if (nativeToolCalls > 0) {
      log.info(
        `model used Kimi's native code-interpreter (ipython) ${nativeToolCalls}x; executed server-side`,
      );
    }
    if (textChars === 0 && thinkingChars === 0) {
      log.warn("stream finished without content");
    }
  }

  private encodeFrame(json: string): ArrayBuffer {
    const jsonBytes = Buffer.from(json, "utf8");
    const ab = new ArrayBuffer(5 + jsonBytes.length);
    const view = new DataView(ab);
    view.setUint8(0, 0); // flag = 0
    view.setUint32(1, jsonBytes.length, false); // length, big-endian
    new Uint8Array(ab, 5).set(jsonBytes);
    return ab;
  }

  private resolveThinkingConfig(
    resolvedModelId: string,
    hasTools: boolean,
    override?: "auto" | "on" | "off",
  ): { enabled: boolean } {
    const mode = override === "off" ? "off" : "auto";
    const thinkingSupported = supportsThinking(KIMI_MODELS, resolvedModelId);
    // С инструментами reasoning выключаем — на web-бэкенде связка ненадёжна.
    return { enabled: thinkingSupported && !hasTools && mode !== "off" };
  }

  /**
   * Kimi принимает один user-блок, поэтому всю переписку «сплющиваем» в единый
   * текст с префиксами ролей; tools-протокол добавляем в самый конец.
   */
  private buildContent(messages: AIMessage[], toolsPrompt: string): string {
    const systems: string[] = [];
    const turns: string[] = [];

    for (const msg of messages) {
      const content = this.contentToString(msg.content).trim();
      if (!content) continue;
      if (msg.role === "system") {
        systems.push(content);
        continue;
      }
      const label = msg.role === "assistant" ? "assistant" : "user";
      turns.push(`${label}:${content}`);
    }

    const parts: string[] = [];
    const languageGuard =
      "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";
    parts.push(`system:${[languageGuard, ...systems].join("\n")}`);
    parts.push(...turns);

    let content = parts.join("\n");
    if (toolsPrompt) {
      content = `${content.trim()}\n\n${toolsPrompt}`;
    }
    return content;
  }

  private lastUserText(messages: AIMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return this.contentToString(messages[i].content);
      }
    }
    return "";
  }

  private contentToString(content: AIMessage["content"]): string {
    if (typeof content === "string") {
      return content;
    }
    return content
      .map((part) => (part.type === "text" ? part.text : "[image]"))
      .join("\n");
  }
}
