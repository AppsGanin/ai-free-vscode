import { vi } from "vitest";
import type { AIStreamChunk } from "../src/providers/types";

/** Everything a provider stream produced, split by kind. */
export interface Collected {
  text: string;
  thinking: string;
  calls: Array<{ name: string; args: unknown }>;
  usage?: { promptTokens: number; completionTokens: number };
  chunks: AIStreamChunk[];
}

export async function collect(
  stream: AsyncIterable<AIStreamChunk>,
): Promise<Collected> {
  const out: Collected = { text: "", thinking: "", calls: [], chunks: [] };
  for await (const chunk of stream) {
    out.chunks.push(chunk);
    if (chunk.type === "text") out.text += chunk.content;
    else if (chunk.type === "thinking") out.thinking += chunk.content;
    else if (chunk.type === "tool_call") {
      let args: unknown = chunk.argumentsPart;
      try {
        args = JSON.parse(chunk.argumentsPart);
      } catch {
        // keep the raw string
      }
      out.calls.push({ name: chunk.name, args });
    } else if (chunk.type === "usage") {
      out.usage = {
        promptTokens: chunk.promptTokens,
        completionTokens: chunk.completionTokens,
      };
    }
  }
  return out;
}

/** `data: {…}\n\n` records, the way an SSE endpoint sends them. */
export function sse(...records: Array<unknown>): string {
  return records
    .map((r) => `data: ${typeof r === "string" ? r : JSON.stringify(r)}\n\n`)
    .join("");
}

/**
 * A response body delivered in small pieces. Real streams split records at
 * arbitrary points — through a JSON string, inside a multi-byte character —
 * and every parser must cope.
 */
export function chunkedBody(
  text: string | Uint8Array,
  size = 7,
): ReadableStream<Uint8Array> {
  const bytes =
    typeof text === "string" ? new TextEncoder().encode(text) : text;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

export interface FakeRoute {
  /** Matched against the request URL. */
  match: RegExp;
  status?: number;
  contentType?: string;
  body: string | Uint8Array | ((request: RecordedRequest) => string);
  /** Split size for the body stream. */
  chunkSize?: number;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Replaces global `fetch` with a router over canned responses. Every request
 * is recorded, so a test can check what the client actually sent.
 */
export function mockFetch(routes: FakeRoute[]): RecordedRequest[] {
  const requests: RecordedRequest[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      let body: unknown = init?.body;
      if (rawBody !== undefined) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = rawBody;
        }
      }
      const request: RecordedRequest = {
        url,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(
          new Headers(init?.headers as HeadersInit | undefined).entries(),
        ),
        body,
      };
      requests.push(request);

      const route = routes.find((r) => r.match.test(url));
      if (!route) {
        return new Response(`no fake route for ${url}`, { status: 599 });
      }
      const payload =
        typeof route.body === "function" ? route.body(request) : route.body;
      return new Response(chunkedBody(payload, route.chunkSize), {
        status: route.status ?? 200,
        headers: { "content-type": route.contentType ?? "text/event-stream" },
      });
    }),
  );

  return requests;
}

/** SecretStorage over a Map: enough for the code that stores sign-ins. */
export function memorySecrets(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values));
  return {
    get: async (key: string) => store.get(key),
    store: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
    keys: async () => [...store.keys()],
    onDidChange: () => ({ dispose() {} }),
  };
}
