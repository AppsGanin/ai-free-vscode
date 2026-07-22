import { createLogger, errToString } from "../../logger";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import {
  buildToolsSystemPrompt,
  selectToolsForPrompt,
} from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { getMimoRoute, resolveMimoModelId } from "./MimoModels";
import type { MimoServer, MimoServerHandle } from "./MimoServer";

const log = createLogger("mimo-api");

const PROVIDER_ID = "ai-free-vscode-mimo";
/** Максимальная пауза между событиями SSE, после которой считаем поток мёртвым. */
const STREAM_IDLE_TIMEOUT_MS = 180000;
/** Заголовок наших одноразовых сессий — по нему же их и подметаем. */
const SESSION_TITLE = "AI Free VSCode";
/**
 * Возраст, начиная с которого сессия считается брошенной. Нужен, чтобы уборка
 * не задела запрос соседнего окна VS Code, работающего с тем же каталогом.
 */
const STALE_SESSION_AGE_MS = 10 * 60 * 1000;
/** Сколько картинок максимум уходит в один запрос. */
const MAX_IMAGES = 8;
/** Пауза между abort и delete: сервер сворачивает генерацию не мгновенно. */
const ABORT_SETTLE_MS = 1000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

interface SseEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface PendingItem {
  partID: string;
  kind: "delta" | "full";
  value: string;
}

/** Картинка, уходящая отдельной частью сообщения. */
interface MimoAttachment {
  mime: string;
  filename: string;
  /** data:image/…;base64,… — ссылки на внешние URL сервер не принимает. */
  url: string;
}

export class MimoApiClient {
  /**
   * Созданные, но ещё не удалённые сессии. Уборку мы не ждём (DELETE висит,
   * пока сервер сворачивает генерацию), поэтому при остановке сервера её нужно
   * успеть доделать — иначе одноразовая сессия остаётся в базе mimocode.
   */
  private readonly liveSessions = new Map<string, MimoServerHandle>();

  /** Сервер, для которого уже прошла уборка брошенных сессий. */
  private sweptUrl?: string;

  constructor(private readonly server: MimoServer) {
    this.server.setBeforeStop(() => this.deleteLiveSessions());
  }

  /**
   * Подметает сессии, оставшиеся от прошлых запусков: если хост расширений упал
   * или его убили посреди генерации, DELETE не долетал и сессия оставалась в
   * базе mimocode навсегда. Разовая операция на каждый поднятый сервер.
   */
  private async sweepStaleSessions(handle: MimoServerHandle): Promise<void> {
    const res = await fetch(`${handle.url}/session`, {
      headers: { Authorization: handle.authHeader },
    }).catch(() => undefined);
    if (!res?.ok) {
      return;
    }

    const sessions = (await res.json().catch(() => [])) as Array<{
      id?: string;
      title?: string;
      directory?: string;
      time?: { updated?: number };
    }>;
    if (!Array.isArray(sessions)) {
      return;
    }

    // Директория сервера приходит уже разрешённой (/private/var/… против /var/…),
    // поэтому сравниваем по суффиксу, а не строгим равенством.
    const ours = handle.directory;
    const cutoff = Date.now() - STALE_SESSION_AGE_MS;

    const stale = sessions.filter(
      (s) =>
        !!s.id &&
        s.title === SESSION_TITLE &&
        !this.liveSessions.has(s.id) &&
        (s.directory === ours || s.directory?.endsWith(ours) === true) &&
        (s.time?.updated ?? 0) < cutoff,
    );
    if (stale.length === 0) {
      return;
    }

    log.info(`sweeping ${stale.length} abandoned session(s)`);
    await Promise.all(
      stale.map((s) => this.deleteSession(handle, s.id as string)),
    );
  }

  /** Удаляет всё, что не успело убраться само (вызывается перед остановкой). */
  private async deleteLiveSessions(): Promise<void> {
    const pending = [...this.liveSessions];
    if (pending.length === 0) {
      return;
    }
    log.debug(`cleaning up ${pending.length} live session(s) before shutdown`);
    await Promise.all(
      pending.map(([sessionID, handle]) =>
        this.deleteSession(handle, sessionID),
      ),
    );
  }

  async *sendMessageStream(
    params: AIRequestParams,
  ): AsyncIterable<AIStreamChunk> {
    const modelId = resolveMimoModelId(params.model);
    const route = getMimoRoute(modelId);
    if (!route) {
      throw new ProviderError(PROVIDER_ID, `Unknown MiMo model: ${params.model}`);
    }

    const handle = await this.server.ensure();

    if (this.sweptUrl !== handle.url) {
      this.sweptUrl = handle.url;
      // В фоне: уборка чужого мусора не должна задерживать ответ пользователю.
      void this.sweepStaleSessions(handle).catch(() => undefined);
    }

    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;

    let toolsPrompt = "";
    if (hasTools && params.tools?.length) {
      toolsPrompt = buildToolsSystemPrompt(
        selectToolsForPrompt(
          params.tools,
          this.lastUserText(params.messages),
          params.toolMode,
        ),
      );
    }

    const content = this.buildContent(params.messages, toolsPrompt);
    const images = this.collectImages(params.messages);
    log.info(
      `request model=${route.providerID}/${route.modelID} hasTools=${hasTools} contentChars=${content.length} images=${images.length}`,
    );

    // SSE подписываемся ДО отправки сообщения, иначе первые дельты потеряются.
    const streamAbort = new AbortController();
    const onAbort = () => streamAbort.abort();
    params.abortSignal?.addEventListener("abort", onAbort);

    let sessionID: string | undefined;
    let finished = false;

    try {
      const eventsResponse = await fetch(`${handle.url}/event`, {
        headers: { Authorization: handle.authHeader },
        signal: streamAbort.signal,
      });
      if (!eventsResponse.ok || !eventsResponse.body) {
        throw new ProviderError(
          PROVIDER_ID,
          `MiMo CLI event stream failed: HTTP ${eventsResponse.status}`,
        );
      }

      sessionID = await this.createSession(handle);

      // POST завершается только по окончании генерации, поэтому не ждём его
      // здесь — читаем события, а ошибку запроса подхватываем из postError.
      let postError: unknown;
      const posted = this.postMessage(
        handle,
        sessionID,
        route,
        content,
        images,
        streamAbort.signal,
      ).catch((err: unknown) => {
        postError = err;
        streamAbort.abort();
      });

      yield* this.consumeEvents(
        eventsResponse.body,
        sessionID,
        allowToolCalls,
        streamAbort,
        () => postError,
      );

      finished = true;
      if (!params.abortSignal?.aborted) {
        await posted.catch(() => undefined);
        if (postError) {
          throw postError;
        }
      }
    } catch (err) {
      if (params.abortSignal?.aborted) {
        log.debug("request aborted by caller");
        return;
      }
      throw err;
    } finally {
      params.abortSignal?.removeEventListener("abort", onAbort);
      streamAbort.abort();
      if (sessionID) {
        // Не ждём уборку: DELETE висит, пока сервер не свернёт генерацию, а нам
        // важно отпустить вызывающего сразу после отмены.
        void this.cleanupSession(handle, sessionID, finished);
      }
    }
  }

  // ─── HTTP-обёртки над локальным сервером mimocode ───────────────────────

  private async createSession(handle: MimoServerHandle): Promise<string> {
    const res = await fetch(
      `${handle.url}/session?directory=${encodeURIComponent(handle.directory)}`,
      {
        method: "POST",
        headers: {
          Authorization: handle.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: SESSION_TITLE }),
      },
    );
    if (!res.ok) {
      throw new ProviderError(
        PROVIDER_ID,
        `MiMo CLI session create failed: HTTP ${res.status}`,
      );
    }
    const session = (await res.json()) as { id?: string };
    if (!session.id) {
      throw new ProviderError(PROVIDER_ID, "MiMo CLI returned no session id");
    }
    this.liveSessions.set(session.id, handle);
    log.debug(`session created: ${session.id}`);
    return session.id;
  }

  private async postMessage(
    handle: MimoServerHandle,
    sessionID: string,
    route: { providerID: string; modelID: string },
    content: string,
    images: MimoAttachment[],
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(
      `${handle.url}/session/${sessionID}/message?directory=${encodeURIComponent(handle.directory)}`,
      {
        method: "POST",
        headers: {
          Authorization: handle.authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent: this.server.agent,
          model: { providerID: route.providerID, modelID: route.modelID },
          // Текст первым, картинки следом — тот же порядок, что шлёт `mimo run -f`.
          parts: [
            { type: "text", text: content },
            ...images.map((image) => ({
              type: "file",
              mime: image.mime,
              filename: image.filename,
              url: image.url,
            })),
          ],
        }),
        signal,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw this.toProviderError(res.status, text);
    }
    await res.json().catch(() => undefined);
  }

  /** Гасит и удаляет одноразовую сессию в фоне (ошибки не важны). */
  private async cleanupSession(
    handle: MimoServerHandle,
    sessionID: string,
    finished: boolean,
  ): Promise<void> {
    if (!finished) {
      await this.abortSession(handle, sessionID);
      await delay(ABORT_SETTLE_MS);
    }
    await this.deleteSession(handle, sessionID);
  }

  private async abortSession(
    handle: MimoServerHandle,
    sessionID: string,
  ): Promise<void> {
    await fetch(
      `${handle.url}/session/${sessionID}/abort?directory=${encodeURIComponent(handle.directory)}`,
      { method: "POST", headers: { Authorization: handle.authHeader } },
    ).catch(() => undefined);
  }

  private async deleteSession(
    handle: MimoServerHandle,
    sessionID: string,
  ): Promise<void> {
    // Сессии одноразовые: весь контекст мы шлём заново каждым запросом.
    const res = await fetch(
      `${handle.url}/session/${sessionID}?directory=${encodeURIComponent(handle.directory)}`,
      { method: "DELETE", headers: { Authorization: handle.authHeader } },
    ).catch((err: unknown) => {
      log.debug(`session delete failed: ${sessionID} — ${errToString(err)}`);
      return undefined;
    });

    if (res && !res.ok) {
      log.warn(`session delete rejected: ${sessionID} — HTTP ${res.status}`);
      return;
    }
    if (res) {
      this.liveSessions.delete(sessionID);
    }
  }

  // ─── Разбор потока событий ──────────────────────────────────────────────

  /**
   * Превращает SSE-поток сервера в чанки провайдера.
   *
   * Части сообщения приходят вперемешку с эхо пользовательского сообщения,
   * а роль сообщения может стать известна ПОСЛЕ его частей, поэтому неготовые
   * куски складываем в очередь и отдаём строго в исходном порядке.
   */
  private async *consumeEvents(
    body: ReadableStream<Uint8Array>,
    sessionID: string,
    allowToolCalls: boolean,
    streamAbort: AbortController,
    getPostError: () => unknown,
  ): AsyncIterable<AIStreamChunk> {
    const router = new StreamingToolCallRouter(
      allowToolCalls,
      (m) => log.debug(m),
      "",
    );

    const roleByMessage = new Map<string, string>();
    const partInfo = new Map<string, { messageID: string; type: string }>();
    const emitted = new Map<string, number>();
    const pending: PendingItem[] = [];

    let textChars = 0;
    let thinkingChars = 0;
    let usageEmitted = false;

    /** Отдаёт из очереди всё, что уже можно классифицировать. */
    function* flush(): Iterable<AIStreamChunk> {
      while (pending.length > 0) {
        const item = pending[0];
        const info = partInfo.get(item.partID);
        if (!info) return;
        const role = roleByMessage.get(info.messageID);
        if (!role) return;
        pending.shift();

        if (role !== "assistant") {
          continue;
        }

        const already = emitted.get(item.partID) ?? 0;
        let text: string;
        if (item.kind === "delta") {
          text = item.value;
          emitted.set(item.partID, already + item.value.length);
        } else {
          if (item.value.length <= already) continue;
          text = item.value.slice(already);
          emitted.set(item.partID, item.value.length);
        }
        if (!text) continue;

        if (info.type === "reasoning") {
          thinkingChars += text.length;
          yield { type: "thinking", content: text };
        } else {
          textChars += text.length;
          yield* router.route(text);
        }
      }
    }

    stream: for await (const event of this.readSse(body, streamAbort.signal)) {
      if (getPostError()) {
        break stream;
      }

      const props = (event.properties ?? {}) as Record<string, unknown>;

      switch (event.type) {
        case "message.updated": {
          const info = props.info as
            | {
                id?: string;
                role?: string;
                sessionID?: string;
                tokens?: unknown;
              }
            | undefined;
          if (!info?.id || info.sessionID !== sessionID) break;
          if (info.role) {
            roleByMessage.set(info.id, info.role);
          }
          yield* flush();
          if (info.role === "assistant" && !usageEmitted) {
            const usage = this.toUsageChunk(info.tokens);
            if (usage) {
              usageEmitted = true;
              yield usage;
            }
          }
          break;
        }

        case "message.part.updated": {
          const part = props.part as
            | {
                id?: string;
                messageID?: string;
                sessionID?: string;
                type?: string;
                text?: string;
              }
            | undefined;
          if (!part?.id || !part.messageID || part.sessionID !== sessionID) {
            break;
          }
          partInfo.set(part.id, {
            messageID: part.messageID,
            type: part.type ?? "text",
          });
          if (
            typeof part.text === "string" &&
            (part.type === "text" || part.type === "reasoning")
          ) {
            pending.push({ partID: part.id, kind: "full", value: part.text });
          }
          yield* flush();
          break;
        }

        case "message.part.delta": {
          const partID = props.partID as string | undefined;
          const delta = props.delta as string | undefined;
          const field = props.field as string | undefined;
          if (
            !partID ||
            typeof delta !== "string" ||
            props.sessionID !== sessionID ||
            (field !== undefined && field !== "text")
          ) {
            break;
          }
          pending.push({ partID, kind: "delta", value: delta });
          yield* flush();
          break;
        }

        case "session.error": {
          if (props.sessionID && props.sessionID !== sessionID) break;
          throw this.toSessionError(props.error);
        }

        case "session.idle": {
          if (props.sessionID !== sessionID) break;
          log.debug("session idle — generation finished");
          yield* flush();
          break stream;
        }

        default:
          break;
      }

      // Роутер увидел границу фейкового следующего хода — дальше только мусор.
      if (router.cut) {
        log.debug("transcript boundary detected — stopping stream");
        break stream;
      }
    }

    yield* router.finish();
    log.info(
      `stream done textChars=${textChars} thinkingChars=${thinkingChars} pending=${pending.length}`,
    );
    if (textChars === 0 && thinkingChars === 0) {
      log.warn("stream finished without content");
    }
  }

  /** Разбирает `text/event-stream` в объекты событий. */
  private async *readSse(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<SseEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const readWithTimeout = async (): Promise<
      ReadableStreamReadResult<Uint8Array>
    > => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProviderError(PROVIDER_ID, "MiMo stream timeout")),
          STREAM_IDLE_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([reader.read(), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      while (!signal.aborted) {
        const { done, value } = await readWithTimeout();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = raw
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try {
            yield JSON.parse(payload) as SseEvent;
          } catch (err) {
            log.debug(`sse parse failed — ${errToString(err)}`);
          }
        }
      }
    } catch (err) {
      const aborted =
        signal.aborted ||
        err instanceof DOMException ||
        (err instanceof Error && /abort/i.test(err.message));
      if (!aborted) throw err;
      log.debug("sse aborted");
    } finally {
      await reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  // ─── Вспомогательное ────────────────────────────────────────────────────

  private toUsageChunk(tokens: unknown): AIStreamChunk | undefined {
    if (!tokens || typeof tokens !== "object") return undefined;
    const t = tokens as { input?: number; output?: number };
    if (typeof t.input !== "number" || typeof t.output !== "number") {
      return undefined;
    }
    if (t.input === 0 && t.output === 0) return undefined;
    return {
      type: "usage",
      promptTokens: t.input,
      completionTokens: t.output,
    };
  }

  private toSessionError(error: unknown): Error {
    const text =
      typeof error === "string" ? error : JSON.stringify(error ?? {});
    log.error(`session error: ${text.slice(0, 400)}`);

    if (/401|403|unauthor|not logged in|no credentials/i.test(text)) {
      return new AuthExpiredError(PROVIDER_ID);
    }
    if (/429|rate.?limit|quota|too many requests/i.test(text)) {
      return new RateLimitError(PROVIDER_ID);
    }
    return new ProviderError(PROVIDER_ID, `MiMo error: ${text.slice(0, 300)}`);
  }

  private toProviderError(status: number, text: string): Error {
    if (status === 401 || status === 403) {
      return new AuthExpiredError(PROVIDER_ID);
    }
    if (status === 429) {
      return new RateLimitError(PROVIDER_ID);
    }
    return new ProviderError(
      PROVIDER_ID,
      `MiMo CLI request failed: HTTP ${status} ${text.slice(0, 200)}`,
      status,
    );
  }

  /**
   * mimocode принимает одно пользовательское сообщение, поэтому переписку
   * «сплющиваем» в единый текст с ролевыми префиксами (как у Kimi/Qwen),
   * а протокол инструментов дописываем в самый конец.
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

    const languageGuard =
      "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";
    const parts = [
      `system:${[languageGuard, ...systems].join("\n")}`,
      ...turns,
    ];

    let content = parts.join("\n");
    if (toolsPrompt) {
      content = `${content.trim()}\n\n${toolsPrompt}`;
    }
    return content;
  }

  /**
   * Картинки из истории — отдельными file-частями: в тексте они остаются
   * пометкой `[image]`, а сюда попадает сам файл.
   */
  private collectImages(messages: AIMessage[]): MimoAttachment[] {
    const images: MimoAttachment[] = [];
    let skipped = 0;

    for (const message of messages) {
      if (typeof message.content === "string") continue;

      for (const part of message.content) {
        if (part.type !== "image_url") continue;

        const url = part.imageUrl.url.trim();
        const match = /^data:(image\/[\w.+-]+);base64,/i.exec(url);
        if (!match) {
          skipped++;
          continue;
        }
        if (images.length >= MAX_IMAGES) {
          skipped++;
          continue;
        }

        const mime = match[1].toLowerCase();
        const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        images.push({
          mime,
          filename: `image-${images.length + 1}.${ext}`,
          url,
        });
      }
    }

    if (skipped > 0) {
      log.warn(
        `${skipped} image(s) not sent: only base64 data URLs are accepted, max ${MAX_IMAGES} per request`,
      );
    }
    return images;
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
    if (typeof content === "string") return content;
    return content
      .map((part) => (part.type === "text" ? part.text : "[image]"))
      .join("\n");
  }
}
