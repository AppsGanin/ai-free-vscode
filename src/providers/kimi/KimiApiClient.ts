import { createLogger } from "../../logger";
import { isAbortError, throwForStatus } from "../common/http";
import { buildFlatTranscript } from "../common/messages";
import { thinkingEnabled } from "../common/models";
import { readChunks } from "../common/stream";
import { StreamingToolCallRouter } from "../common/StreamingToolCallRouter";
import { buildToolsSystemPrompt, createToolCallChunk } from "../common/ToolCalling";
import type { AIRequestParams, AIStreamChunk, AIToolDefinition } from "../types";
import { ProviderError } from "../types";
import { chatTarget } from "./KimiChatModel";
import { KIMI_MODELS, resolveKimiModelId } from "./KimiModels";

const PROVIDER_ID = "ai-free-vscode-kimi";
/** Used when the session does not say which region it belongs to. */
const DEFAULT_ORIGIN = "https://www.kimi.com";
const CHAT_PATH = "/apiv2/kimi.gateway.chat.v1.ChatService/Chat";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STREAM_TIMEOUT_MS = 120000;
/**
 * Conservative share of the model's 131k input window. The whole conversation
 * is flattened into one turn, so agent loops carrying whole files in their tool
 * results run past it; the oldest turns are dropped rather than letting the
 * upstream refuse the request outright.
 */
const MAX_PROMPT_TOKENS = 75000;
/** Connect protocol frame header: 1 flag byte + 4 length bytes. */
const FRAME_HEADER_BYTES = 5;

/**
 * Kimi runs its own tools (ipython, shell, browser) on its servers, and no
 * request field turns them off. With the caller's tools on offer such a call
 * is an escape: the work would happen in Kimi's sandbox, with none of the
 * user's files. A command or Python run is handed to the caller's own command
 * tool instead — it is what the model meant to do, just in the wrong place;
 * anything else is asked again with a reminder.
 */
const SERVER_TOOL_RETRIES = 2;

const log = createLogger("kimi-api");

/** The model reached for one of Kimi's own server-side tools. */
class ServerToolEscape extends Error {
  constructor(
    readonly tool: string,
    /** The call's JSON arguments, as far as they arrived. */
    readonly args: string,
  ) {
    super(`Kimi started its own ${tool} tool`);
  }
}

function serverToolReminder(commandTool: string | undefined): string {
  return (
    "IMPORTANT: your built-in tools (ipython, shell, browser, web search, files) are NOT available here: " +
    "they run on a remote machine that has none of the user's files. Act only through the tools listed above, " +
    "in the tool_call format." +
    (commandTool ? ` To run a command, tests or code, call ${commandTool}.` : "")
  );
}

/** The caller's tool that runs a shell command, and its command parameter. */
function commandToolOf(
  tools: readonly AIToolDefinition[] | undefined,
): { tool: AIToolDefinition; param: string } | undefined {
  for (const tool of tools ?? []) {
    if (!/terminal|bash|shell|run_command|execute_command|^exec$/i.test(tool.name)) continue;
    const props = (tool.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
    const param = ["command", "cmd", "script"].find((key) => props[key]?.type === "string");
    if (param) return { tool, param };
  }
  return undefined;
}

/**
 * Kimi's shell/ipython call as a call of the caller's command tool, or
 * undefined when it cannot be carried over (other tools, or code that works
 * on Kimi's own sandbox files under /mnt).
 */
export function translateServerCall(
  tool: string,
  rawArgs: string,
  tools: readonly AIToolDefinition[] | undefined,
): AIStreamChunk | undefined {
  const target = commandToolOf(tools);
  if (!target) return undefined;
  let args: { command?: unknown; code?: unknown };
  try {
    args = JSON.parse(rawArgs) as typeof args;
  } catch {
    return undefined;
  }
  let command: string | undefined;
  if (tool === "shell" && typeof args.command === "string") command = args.command;
  else if (tool === "ipython" && typeof args.code === "string") {
    command = `python3 - <<'PY'\n${args.code}\nPY`;
  }
  if (!command?.trim() || /\/mnt\//.test(command)) return undefined;

  const input: Record<string, unknown> = { [target.param]: command };
  // Whatever else the tool requires (run_in_terminal: explanation,
  // isBackground) gets a neutral value.
  const schema = target.tool.parameters as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  for (const key of schema.required ?? []) {
    if (key in input) continue;
    const type = schema.properties?.[key]?.type;
    if (type === "string") input[key] = "Run the command the model asked for";
    else if (type === "boolean") input[key] = false;
  }
  return createToolCallChunk({ name: target.tool.name, argumentsValue: input });
}

export interface KimiAuthState {
  token: string;
  /**
   * Region of the account: kimi.ai (global) or kimi.com (China). The two are
   * separate services — a token from one is refused by the other.
   */
  origin?: string;
}

interface KimiFrame {
  error?: { message?: string; code?: string } | string;
  heartbeat?: unknown;
  op?: string;
  done?: unknown;
  block?: {
    type?: string;
    text?: { content?: string };
    thinking?: { content?: string };
    tool?: unknown;
  };
  chat?: { id?: string };
  message?: { id?: string; role?: string };
}

export class KimiApiClient {
  async *sendMessageStream(
    params: AIRequestParams,
    auth: KimiAuthState,
  ): AsyncIterable<AIStreamChunk> {
    const modelId = resolveKimiModelId(params.model);
    const hasTools = (params.tools?.length ?? 0) > 0;
    const allowToolCalls = params.toolMode !== "none" && hasTools;
    const thinking = thinkingEnabled(
      KIMI_MODELS,
      modelId,
      hasTools,
      params.thinkingMode,
    );

    const origin = auth.origin ?? DEFAULT_ORIGIN;
    const target = await chatTarget(origin, auth.token);

    for (let attempt = 0; ; attempt++) {
      const reminder =
        attempt > 0 ? `\n\n${serverToolReminder(commandToolOf(params.tools)?.tool.name)}` : "";
      const content =
        buildFlatTranscript(
          params.messages,
          hasTools ? buildToolsSystemPrompt(params.tools ?? []) : "",
          { maxTokens: MAX_PROMPT_TOKENS },
        ) + reminder;

      log.info(
        `request model=${modelId} target=${target.model ?? target.scenario} thinking=${thinking} hasTools=${hasTools} contentChars=${content.length}${
          attempt > 0 ? ` retry=${attempt}` : ""
        }`,
      );

      // Our own signal as well: a server-tool turn is cut short here.
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      params.abortSignal?.addEventListener("abort", onAbort, { once: true });

      let shown = false;
      try {
        const response = await fetch(`${origin}${CHAT_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token}`,
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            Origin: origin,
            Referer: `${origin}/`,
            "User-Agent": USER_AGENT,
            "X-Msh-Platform": "web",
          },
          body: encodeFrame(
            JSON.stringify({
              scenario: target.scenario,
              chat_id: "",
              tools: [],
              message: {
                parent_id: "",
                role: "user",
                blocks: [{ message_id: "", text: { content } }],
                scenario: target.scenario,
              },
              options: { thinking, ...(target.model ? { model: target.model } : {}) },
            }),
          ),
          signal: controller.signal,
        });

        log.debug(`response status=${response.status}`);
        throwForStatus(PROVIDER_ID, response);

        if (!response.ok || !response.body) {
          const txt = await response.text().catch(() => "");
          log.error(`request failed HTTP ${response.status}: ${txt.slice(0, 220)}`);
          throw new ProviderError(
            PROVIDER_ID,
            `HTTP ${response.status}: ${txt.slice(0, 220)}`,
            response.status,
          );
        }

        for await (const chunk of this.parseFrames(
          response.body,
          allowToolCalls,
          params.abortSignal,
        )) {
          if (chunk.type === "text" || chunk.type === "tool_call") shown = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (!(err instanceof ServerToolEscape)) throw err;
        controller.abort();
        const handedOver = translateServerCall(err.tool, err.args, params.tools);
        if (handedOver?.type === "tool_call") {
          log.info(`${err.message} — handing it to ${handedOver.name} on the user's side`);
          yield handedOver;
          return;
        }
        log.debug(`server ${err.tool} args: ${err.args.slice(0, 300)}`);
        if (shown) {
          // Asking again would repeat what the user already saw: the turn
          // ends on its text, and the next one starts clean.
          log.warn(`${err.message} after answering — ending the turn there`);
          return;
        }
        if (attempt >= SERVER_TOOL_RETRIES) {
          throw new ProviderError(
            PROVIDER_ID,
            `Kimi kept reaching for its own server-side ${err.tool} instead of the provided tools`,
          );
        }
        log.info(`${err.message} — cut before it ran, asking again with a reminder`);
      } finally {
        params.abortSignal?.removeEventListener("abort", onAbort);
      }
    }
  }

  private async *parseFrames(
    body: ReadableStream<Uint8Array>,
    allowToolCalls: boolean,
    abortSignal?: AbortSignal,
  ): AsyncIterable<AIStreamChunk> {
    const router = new StreamingToolCallRouter(allowToolCalls, (m) =>
      log.debug(m),
    );
    let buffer = Buffer.alloc(0);
    let textChars = 0;
    let thinkingChars = 0;
    let nativeToolCalls = 0;
    let done = false;
    /** A server tool call being streamed, before Kimi starts it. */
    let escape: { name: string; args: string } | undefined;
    /** The last frames, for the log when a stream carries nothing. */
    const lastFrames: string[] = [];

    const handleFrame = function* (frame: KimiFrame): Iterable<AIStreamChunk> {
      if (frame.error) {
        const text =
          typeof frame.error === "string"
            ? frame.error
            : (frame.error.message ?? frame.error.code ?? "Kimi API error");
        throw new ProviderError(PROVIDER_ID, `Kimi error: ${text}`);
      }
      if (frame.heartbeat) return;

      if (frame.block?.tool) {
        const tool = frame.block.tool as { name?: string; args?: string; status?: string };
        // With the caller's tools on offer, Kimi's own (server-side) tools are
        // an escape. Its arguments stream in first; they are taken whole,
        // then the stream is cut.
        if (allowToolCalls) {
          if (tool.name) escape = { name: tool.name, args: "" };
          if (escape && typeof tool.args === "string") {
            escape.args = frame.op === "append" ? escape.args + tool.args : tool.args;
          }
          if (escape && (tool.status === "STATUS_RUNNING" || tool.status === "STATUS_DONE")) {
            throw new ServerToolEscape(escape.name, escape.args);
          }
          return;
        }
        // In a plain chat it runs server-side and keeps generating, so we
        // just wait for the resulting text and only count the calls.
        if (frame.op === "set") nativeToolCalls++;
        return;
      }
      if (frame.op !== "append" && frame.op !== "set") {
        done = frame.done !== undefined;
        return;
      }

      const thinking = frame.block?.thinking?.content;
      if (thinking) {
        thinkingChars += thinking.length;
        yield { type: "thinking", content: thinking };
      }

      const text = frame.block?.text?.content;
      if (text) {
        if (/think|reason/i.test(frame.block?.type ?? "")) {
          thinkingChars += text.length;
          yield { type: "thinking", content: text };
        } else {
          textChars += text.length;
          yield* router.route(text);
        }
      }

      if (frame.done !== undefined) done = true;
    };

    try {
      for await (const chunk of readChunks(body, {
        providerId: PROVIDER_ID,
        idleTimeoutMs: STREAM_TIMEOUT_MS,
      })) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        let offset = 0;
        while (offset + FRAME_HEADER_BYTES <= buffer.length) {
          const length = buffer.readUInt32BE(offset + 1);
          const end = offset + FRAME_HEADER_BYTES + length;
          if (end > buffer.length) break;

          const payload = buffer
            .subarray(offset + FRAME_HEADER_BYTES, end)
            .toString("utf8")
            .trim();
          offset = end;

          if (payload) {
            lastFrames.push(payload.slice(0, 200));
            if (lastFrames.length > 4) lastFrames.shift();
            try {
              yield* handleFrame(JSON.parse(payload) as KimiFrame);
            } catch (err) {
              if (err instanceof ProviderError || err instanceof ServerToolEscape) throw err;
              log.debug(`frame parse failed: ${payload.slice(0, 120)}`);
            }
          }
          if (router.cut) {
            log.debug("transcript boundary detected — stopping stream");
            done = true;
          }
          if (done) break;
        }

        buffer = buffer.subarray(offset);
        if (done) break;
      }
    } catch (err) {
      if (!isAbortError(err, abortSignal)) {
        throw err;
      }
      log.debug("stream aborted by caller");
    }

    // The stream ended inside a server tool call: still an escape.
    if (escape) throw new ServerToolEscape(escape.name, escape.args);

    yield* router.finish();

    log.info(
      `stream done textChars=${textChars} thinkingChars=${thinkingChars} nativeToolCalls=${nativeToolCalls}`,
    );
    if (textChars === 0 && thinkingChars === 0) {
      log.warn(`stream finished without content — last frames: ${lastFrames.join(" | ")}`);
    }
  }
}

/** Connect protocol frame: flag byte + big-endian length + JSON payload. */
function encodeFrame(json: string): ArrayBuffer {
  const bytes = Buffer.from(json, "utf8");
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + bytes.length);
  const view = new DataView(buffer);
  view.setUint8(0, 0);
  view.setUint32(1, bytes.length, false);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(bytes);
  return buffer;
}
