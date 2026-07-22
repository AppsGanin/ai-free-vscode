import { ProviderError } from "../types";
import { isAbortError } from "./http";

export interface ReadOptions {
  providerId: string;
  /** Max pause between reads; the upstream can hold a socket open forever. */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface SseEvent {
  event: string;
  data: string;
}

/** Reads a response body, cancelling the reader on early exit. */
export async function* readChunks(
  body: ReadableStream<Uint8Array>,
  opts: ReadOptions,
): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    while (!opts.signal?.aborted) {
      const { done, value } = await withIdleTimeout(reader.read(), opts);
      if (done) break;
      if (value?.length) yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/** Same as readChunks, decoded to text (trailing bytes flushed at the end). */
export async function* readText(
  body: ReadableStream<Uint8Array>,
  opts: ReadOptions,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of readChunks(body, opts)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Passes a stream through, treating cancellation as a normal end. */
export async function* ignoreAbort<T>(
  source: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncIterable<T> {
  try {
    yield* source;
  } catch (err) {
    if (!isAbortError(err, signal)) throw err;
  }
}

/** Splits a `text/event-stream` into its `event:` / `data:` records. */
export async function* sseEvents(
  chunks: AsyncIterable<string>,
): AsyncIterable<SseEvent> {
  let buffer = "";

  for await (const chunk of chunks) {
    buffer += chunk;
    for (;;) {
      const boundary = findBoundary(buffer);
      if (!boundary) break;
      const raw = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const event = parseEvent(raw);
      if (event.data) yield event;
    }
  }

  // Final record may arrive without a trailing blank line.
  const tail = parseEvent(buffer);
  if (tail.data) yield tail;
}

function withIdleTimeout<T>(
  promise: Promise<T>,
  opts: ReadOptions,
): Promise<T> {
  if (!opts.idleTimeoutMs) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderError(opts.providerId, "stream timeout")),
      opts.idleTimeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function findBoundary(
  input: string,
): { index: number; length: number } | undefined {
  const lf = input.indexOf("\n\n");
  const crlf = input.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return undefined;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 };
}

function parseEvent(raw: string): SseEvent {
  const result: SseEvent = { event: "", data: "" };
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      result.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      result.data += (result.data ? "\n" : "") + line.slice(5).trimStart();
    }
  }
  return result;
}
