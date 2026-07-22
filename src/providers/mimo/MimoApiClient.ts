import { createLogger, errToString } from "../../logger";
import { toProviderError } from "../common/http";
import { buildFlatTranscript } from "../common/messages";
import { ignoreAbort, readText, sseEvents } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import { buildToolsSystemPrompt } from "../common/ToolCalling";
import type { AIMessage, AIRequestParams, AIStreamChunk } from "../types";
import { AuthExpiredError, ProviderError, RateLimitError } from "../types";
import { getMimoRoute } from "./MimoModels";
import type { MimoServer, MimoServerHandle } from "./MimoServer";

const log = createLogger("mimo-api");

const PROVIDER_ID = "ai-free-vscode-mimo";
const STREAM_IDLE_TIMEOUT_MS = 180000;
/** Title of our throwaway sessions — also how the sweeper recognises them. */
const SESSION_TITLE = "AI Free VSCode";
/** Age at which a session counts as abandoned (never touch a sibling window's). */
const STALE_SESSION_AGE_MS = 10 * 60 * 1000;
const MAX_IMAGES = 8;
/** The server needs a moment to wind generation down between abort and delete. */
const ABORT_SETTLE_MS = 1000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

interface PendingItem {
  partID: string;
  kind: "delta" | "full";
  value: string;
}

/** Image sent as a separate message part. */
interface MimoAttachment {
  mime: string;
  filename: string;
  /** data:image/…;base64,… — the server rejects external URLs. */
  url: string;
}

export class MimoApiClient {
  /**
   * Created but not yet deleted sessions. Cleanup is not awaited (DELETE blocks
   * while the server winds generation down), so it has to finish before the
   * server stops — otherwise the session stays in the mimocode database.
   */
  private readonly liveSessions = new Map<string, MimoServerHandle>();
  private sweptUrl?: string;

  constructor(private readonly server: MimoServer) {
    this.server.setBeforeStop(() => this.deleteLiveSessions());
  }

  async *sendMessageStream(
    params: AIRequestParams,
  ): AsyncIterable<AIStreamChunk> {
    const route = getMimoRoute(params.model);
    if (!route) {
      throw new ProviderError(
        PROVIDER_ID,
        `Unknown MiMo model: ${params.model}`,
      );
    }

    const handle = await this.server.ensure();
    if (this.sweptUrl !== handle.url) {
      this.sweptUrl = handle.url;
      // In the background: cleaning old junk must not delay the answer.
      void this.sweepStaleSessions(handle).catch(() => undefined);
    }

    const hasTools = (params.tools?.length ?? 0) > 0;
    const content = buildFlatTranscript(
      params.messages,
      hasTools ? buildToolsSystemPrompt(params.tools ?? []) : "",
    );
    const images = collectImages(params.messages);
    log.info(
      `request model=${route.providerID}/${route.modelID} hasTools=${hasTools} contentChars=${content.length} images=${images.length}`,
    );

    // Subscribe to SSE BEFORE posting, otherwise the first deltas are lost.
    const streamAbort = new AbortController();
    const onAbort = () => streamAbort.abort();
    params.abortSignal?.addEventListener("abort", onAbort);

    let sessionID: string | undefined;
    let finished = false;

    try {
      const events = await fetch(`${handle.url}/event`, {
        headers: { Authorization: handle.authHeader },
        signal: streamAbort.signal,
      });
      if (!events.ok || !events.body) {
        throw new ProviderError(
          PROVIDER_ID,
          `MiMo CLI event stream failed: HTTP ${events.status}`,
        );
      }

      sessionID = await this.createSession(handle);

      // The POST only resolves once generation ends, so it is not awaited here;
      // its failure is picked up through postError.
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
        events.body,
        sessionID,
        params.toolMode !== "none" && hasTools,
        streamAbort.signal,
        () => postError,
      );

      finished = true;
      if (!params.abortSignal?.aborted) {
        await posted.catch(() => undefined);
        if (postError) throw postError;
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
      // Not awaited: DELETE blocks until generation stops, and the caller has
      // to be released right after cancellation.
      if (sessionID) void this.cleanupSession(handle, sessionID, finished);
    }
  }

  // ─── Local mimocode server ────────────────────────────────────────────────

  private sessionUrl(handle: MimoServerHandle, suffix = ""): string {
    return `${handle.url}/session${suffix}?directory=${encodeURIComponent(
      handle.directory,
    )}`;
  }

  private async createSession(handle: MimoServerHandle): Promise<string> {
    const res = await fetch(this.sessionUrl(handle), {
      method: "POST",
      headers: {
        Authorization: handle.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: SESSION_TITLE }),
    });
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
    const res = await fetch(this.sessionUrl(handle, `/${sessionID}/message`), {
      method: "POST",
      headers: {
        Authorization: handle.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: this.server.agent,
        model: route,
        // Text first, images after — the order `mimo run -f` uses.
        parts: [
          { type: "text", text: content },
          ...images.map((image) => ({ type: "file", ...image })),
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw toProviderError(PROVIDER_ID, res.status, text);
    }
    await res.json().catch(() => undefined);
  }

  /** Stops and deletes a throwaway session in the background. */
  private async cleanupSession(
    handle: MimoServerHandle,
    sessionID: string,
    finished: boolean,
  ): Promise<void> {
    if (!finished) {
      await fetch(this.sessionUrl(handle, `/${sessionID}/abort`), {
        method: "POST",
        headers: { Authorization: handle.authHeader },
      }).catch(() => undefined);
      await delay(ABORT_SETTLE_MS);
    }
    await this.deleteSession(handle, sessionID);
  }

  private async deleteSession(
    handle: MimoServerHandle,
    sessionID: string,
  ): Promise<void> {
    const res = await fetch(this.sessionUrl(handle, `/${sessionID}`), {
      method: "DELETE",
      headers: { Authorization: handle.authHeader },
    }).catch((err: unknown) => {
      log.debug(`session delete failed: ${sessionID} — ${errToString(err)}`);
      return undefined;
    });

    if (!res) return;
    if (res.ok) {
      this.liveSessions.delete(sessionID);
    } else {
      log.warn(`session delete rejected: ${sessionID} — HTTP ${res.status}`);
    }
  }

  /**
   * Removes sessions left by earlier runs: if the extension host died mid
   * generation the DELETE never landed and the session stayed forever. Runs
   * once per started server.
   */
  private async sweepStaleSessions(handle: MimoServerHandle): Promise<void> {
    const res = await fetch(`${handle.url}/session`, {
      headers: { Authorization: handle.authHeader },
    }).catch(() => undefined);
    if (!res?.ok) return;

    const sessions = (await res.json().catch(() => [])) as Array<{
      id?: string;
      title?: string;
      directory?: string;
      time?: { updated?: number };
    }>;
    if (!Array.isArray(sessions)) return;

    // The server resolves its directory (/private/var/… vs /var/…), so compare
    // by suffix rather than equality.
    const cutoff = Date.now() - STALE_SESSION_AGE_MS;
    const stale = sessions.filter(
      (s) =>
        !!s.id &&
        s.title === SESSION_TITLE &&
        !this.liveSessions.has(s.id) &&
        (s.directory === handle.directory ||
          s.directory?.endsWith(handle.directory) === true) &&
        (s.time?.updated ?? 0) < cutoff,
    );
    if (stale.length === 0) return;

    log.info(`sweeping ${stale.length} abandoned session(s)`);
    await Promise.all(
      stale.map((s) => this.deleteSession(handle, s.id as string)),
    );
  }

  private async deleteLiveSessions(): Promise<void> {
    const pending = [...this.liveSessions];
    if (pending.length === 0) return;
    log.debug(`cleaning up ${pending.length} live session(s) before shutdown`);
    await Promise.all(
      pending.map(([sessionID, handle]) =>
        this.deleteSession(handle, sessionID),
      ),
    );
  }

  // ─── Event stream ─────────────────────────────────────────────────────────

  /**
   * Turns the server's SSE stream into provider chunks.
   *
   * Message parts arrive interleaved with the echo of the user message, and a
   * message's role can become known AFTER its parts — so unclassified pieces
   * queue up and are released strictly in arrival order.
   */
  private async *consumeEvents(
    body: ReadableStream<Uint8Array>,
    sessionID: string,
    allowToolCalls: boolean,
    signal: AbortSignal,
    getPostError: () => unknown,
  ): AsyncIterable<AIStreamChunk> {
    const router = new StreamingToolCallRouter(allowToolCalls, (m) =>
      log.debug(m),
    );

    const roleByMessage = new Map<string, string>();
    const partInfo = new Map<string, { messageID: string; type: string }>();
    const emitted = new Map<string, number>();
    const pending: PendingItem[] = [];

    let textChars = 0;
    let thinkingChars = 0;
    let usageEmitted = false;

    /** Releases everything at the head of the queue that can be classified. */
    function* flush(): Iterable<AIStreamChunk> {
      while (pending.length > 0) {
        const item = pending[0];
        const info = partInfo.get(item.partID);
        if (!info) return;
        const role = roleByMessage.get(info.messageID);
        if (!role) return;
        pending.shift();
        if (role !== "assistant") continue;

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

    const source = ignoreAbort(
      readText(body, {
        providerId: PROVIDER_ID,
        idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        signal,
      }),
      signal,
    );

    stream: for await (const raw of sseEvents(source)) {
      if (getPostError()) break stream;

      let event: { type?: string; properties?: Record<string, unknown> };
      try {
        event = JSON.parse(raw.data);
      } catch (err) {
        log.debug(`sse parse failed — ${errToString(err)}`);
        continue;
      }
      const props = event.properties ?? {};

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
          if (info.role) roleByMessage.set(info.id, info.role);
          yield* flush();

          const usage =
            info.role === "assistant" && !usageEmitted
              ? toUsageChunk(info.tokens)
              : undefined;
          if (usage) {
            usageEmitted = true;
            yield usage;
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

        case "session.error":
          if (props.sessionID && props.sessionID !== sessionID) break;
          throw toSessionError(props.error);

        case "session.idle":
          if (props.sessionID !== sessionID) break;
          log.debug("session idle — generation finished");
          yield* flush();
          break stream;
      }

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
}

function toUsageChunk(tokens: unknown): AIStreamChunk | undefined {
  const t = tokens as { input?: number; output?: number } | null;
  if (typeof t?.input !== "number" || typeof t.output !== "number") {
    return undefined;
  }
  if (t.input === 0 && t.output === 0) return undefined;
  return { type: "usage", promptTokens: t.input, completionTokens: t.output };
}

function toSessionError(error: unknown): Error {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? {});
  log.error(`session error: ${text.slice(0, 400)}`);

  if (/401|403|unauthor|not logged in|no credentials/i.test(text)) {
    return new AuthExpiredError(PROVIDER_ID);
  }
  if (/429|rate.?limit|quota|too many requests/i.test(text)) {
    return new RateLimitError(PROVIDER_ID);
  }
  return new ProviderError(PROVIDER_ID, `MiMo error: ${text.slice(0, 300)}`);
}

/**
 * Images from the history go as separate file parts; the text keeps an
 * `[image]` placeholder where they were.
 */
function collectImages(messages: AIMessage[]): MimoAttachment[] {
  const images: MimoAttachment[] = [];
  let skipped = 0;

  for (const message of messages) {
    if (typeof message.content === "string") continue;

    for (const part of message.content) {
      if (part.type !== "image_url") continue;

      const url = part.imageUrl.url.trim();
      const match = /^data:(image\/[\w.+-]+);base64,/i.exec(url);
      if (!match || images.length >= MAX_IMAGES) {
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
