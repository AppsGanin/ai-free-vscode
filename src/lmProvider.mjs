/**
 * Unified language model provider for VS Code.
 * Groups all providers under a single vendor «ai-free-vscode».
 *
 * API: vscode.lm.registerLanguageModelChatProvider(vendor, provider)
 * Interface: LanguageModelChatProvider
 */

import * as vscode from "vscode";
import {
  MODELS as DEEPSEEK_MODELS,
  runComplete as deepseekComplete,
  formatBizError,
} from "./deepseek/provider.mjs";
import { messagesToPrompt, parseToolCalls } from "./promptUtils.mjs";
import {
  MODELS as QWEN_MODELS,
  runComplete as qwenComplete,
} from "./qwen/provider.mjs";

const VENDOR = "ai-free-vscode";

const MODELS = [...DEEPSEEK_MODELS, ...QWEN_MODELS];

const MIN_LINE_NUMBER = 1;
const MAX_LINE_NUMBER = 9999;

/**
 * Converts LanguageModelChatMessage[] → OpenAI-compatible format
 * for messagesToPrompt(). Supports tool calls and tool results.
 */
function convertMessages(messages) {
  return messages
    .map((msg) => {
      const isAssistant =
        msg.role === vscode.LanguageModelChatMessageRole.Assistant;
      const role = isAssistant ? "assistant" : "user";

      const content = (msg.content ?? [])
        .map((part) => {
          if (part instanceof vscode.LanguageModelTextPart) return part.value;
          if (typeof part === "string") return part;
          return "";
        })
        .join("");

      // Collect tool calls from assistant message
      const toolCallParts = (msg.content ?? []).filter(
        (p) => p instanceof vscode.LanguageModelToolCallPart,
      );
      const toolCalls = toolCallParts.map((p) => ({
        id: p.callId,
        type: "function",
        function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
      }));

      // Collect tool results from user message
      const toolResultParts = (msg.content ?? []).filter(
        (p) => p instanceof vscode.LanguageModelToolResultPart,
      );

      if (toolResultParts.length > 0) {
        // Each tool result → separate message with role="tool"
        return toolResultParts.map((p) => ({
          role: "tool",
          tool_call_id: p.callId,
          content: (p.content ?? [])
            .map((c) =>
              c instanceof vscode.LanguageModelTextPart ? c.value : String(c),
            )
            .join(""),
        }));
      }

      const result = { role, content };
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
      return result;
    })
    .flat();
}

/**
 * Converts LanguageModelChatTool[] → BUILTIN_TOOLS format for messagesToPrompt()
 */
function convertToolSchemas(tools) {
  return (tools ?? []).map((t) => {
    const schema = t.inputSchema ?? { type: "object", properties: {} };
    // Patch startLine/endLine descriptions so the model doesn't generate invalid values
    const props = schema.properties ?? {};
    if ("startLine" in props || "endLine" in props) {
      const enhanced = JSON.parse(JSON.stringify(schema));
      if (enhanced.properties.startLine) {
        enhanced.properties.startLine.description = `1-based line number to start reading from (inclusive). Default: ${MIN_LINE_NUMBER}`;
      }
      if (enhanced.properties.endLine) {
        enhanced.properties.endLine.description = `1-based line number to end reading at (inclusive). To read the whole file use ${MAX_LINE_NUMBER}. Must be >= startLine.`;
      }
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description ?? "",
          parameters: enhanced,
        },
      };
    }
    return {
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: schema,
      },
    };
  });
}

class AiFreeVscodeChatModelProvider {
  constructor(deepseekAuth, qwenAuth) {
    this._deepseekAuth = deepseekAuth;
    this._qwenAuth = qwenAuth;
  }

  /** Returns the list of models */
  provideLanguageModelChatInformation(_options, _token) {
    return MODELS;
  }

  /** Handles a request and streams the response via progress.report() */
  async provideLanguageModelChatResponse(
    model,
    messages,
    options,
    progress,
    token,
  ) {
    const convertedMessages = convertMessages(messages);
    const tools = convertToolSchemas(options?.tools);
    const prompt = messagesToPrompt(
      convertedMessages,
      tools.length ? tools : null,
    );

    // Stable key for the VS Code chat thread — derived from the first user
    // message so that continuing the same thread reuses the backend chat
    // while a new thread gets a fresh one.
    const firstUserMsg = messages.find(
      (m) => m.role === vscode.LanguageModelChatMessageRole.User,
    );
    const firstContent = (firstUserMsg?.content ?? [])
      .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ""))
      .join("")
      .slice(0, 64);
    const threadKey = `${model.id}:${firstContent}`;
    const abort = tokenToAbort(token);
    const hasTools = tools.length > 0;
    let fullText = "";

    console.error(
      `[ai-free-vscode] model=${model.id} family=${model.family} messages=${messages.length} tools=${tools.length}`,
    );

    /**
     * Stream text chunks immediately, but suppress ```tool_call blocks.
     * A partial-match buffer holds back text that might be the start of a
     * tool_call fence until we know for sure it is (or isn't).
     */
    // Fences that mark the start of a tool call block in the stream.
    // The model sometimes uses the markdown fence (```tool_call) and
    // sometimes outputs just the label on its own line (tool_call\n{).
    const TOOL_FENCES = ["```tool_call", "\ntool_call\n{", "tool_call\n{"];
    let streamBuf = ""; // holds text that may be a partial TOOL_FENCE prefix
    let inToolCall = false; // true once we see any tool call fence

    /** Returns the earliest index of any tool call fence in str, or -1 */
    const findFence = (str) => {
      let best = -1;
      for (const fence of TOOL_FENCES) {
        const idx = str.indexOf(fence);
        if (idx !== -1 && (best === -1 || idx < best)) best = idx;
      }
      return best;
    };

    /**
     * Returns how many characters at the END of str could be a partial
     * prefix of any tool call fence (so we must hold them back).
     */
    const partialHoldBack = (str) => {
      let max = 0;
      for (const fence of TOOL_FENCES) {
        for (
          let len = Math.min(fence.length - 1, str.length);
          len >= 1;
          len--
        ) {
          if (fence.startsWith(str.slice(-len))) {
            if (len > max) max = len;
            break;
          }
        }
      }
      return max;
    };

    const flushStream = async (text) => {
      if (!text) return;
      if (thinkingStarted && !contentStarted) {
        contentStarted = true;
        // Emit accumulated thinking as a native collapsible block
        if (thinkingText && vscode.LanguageModelThinkingPart) {
          progress.report(
            new vscode.LanguageModelThinkingPart(
              thinkingText,
              "thinking-0",
              undefined,
            ),
          );
        } else if (thinkingText) {
          // Fallback: blockquote
          const formatted = thinkingText.replace(/\n/g, "\n> ");
          progress.report(
            new vscode.LanguageModelTextPart(
              `> 💭 **Thinking**\n> \n> ${formatted}\n\n---\n\n`,
            ),
          );
        }
        await new Promise((r) => setImmediate(r));
      }
      progress.report(new vscode.LanguageModelTextPart(text));
      await new Promise((r) => setImmediate(r));
    };

    const onText = async (text) => {
      if (token.isCancellationRequested) return;
      fullText += text;

      if (inToolCall) return; // inside a tool_call block — suppress everything

      streamBuf += text;

      // Process buffer: emit safe parts, hold back potential fence prefix
      while (streamBuf.length > 0) {
        const idx = findFence(streamBuf);
        if (idx !== -1) {
          // Found a fence — emit text before it, then suppress the rest
          await flushStream(streamBuf.slice(0, idx));
          streamBuf = "";
          inToolCall = true;
          break;
        }

        // No fence found — check if the buffer ENDS with a partial fence prefix
        const holdBack = partialHoldBack(streamBuf);

        // Emit everything except the potentially-partial suffix
        const safe = streamBuf.slice(0, streamBuf.length - holdBack);
        await flushStream(safe);
        streamBuf = streamBuf.slice(streamBuf.length - holdBack);
        break;
      }
    };

    /**
     * Thinking/reasoning content — accumulated and emitted as a native
     * LanguageModelThinkingPart (collapsible "Thinking" block in VS Code).
     * Falls back to a blockquote if the API is unavailable.
     */
    let thinkingStarted = false;
    let contentStarted = false;
    let thinkingText = "";
    const onThinking = async (text) => {
      if (token.isCancellationRequested) return;
      thinkingText += text;
      thinkingStarted = true;
    };

    try {
      switch (model.family) {
        case "deepseek":
          await deepseekComplete({
            modelId: model.id,
            prompt,
            auth: this._deepseekAuth,
            onText,
            signal: abort.signal,
            threadKey,
          });
          break;

        case "qwen":
          await qwenComplete({
            modelId: model.id,
            prompt,
            auth: this._qwenAuth,
            onText,
            onThinking,
            signal: abort.signal,
            threadKey,
          });
          break;

        default:
          throw new Error(`Unsupported model family: ${model.family}`);
      }
    } catch (e) {
      if (e?.isNotSignedIn) {
        progress.report(new vscode.LanguageModelTextPart(e.message));
        return;
      }
      console.error(`[ai-free-vscode] ERROR: ${e?.name}: ${e?.message}`);
      console.error(`[ai-free-vscode] stack: ${e?.stack}`);
      if (token.isCancellationRequested || isAbortError(e)) {
        progress.report(
          new vscode.LanguageModelTextPart("⏹️ Cancelled by user."),
        );
        return;
      }
      if (e?.isBizError) {
        progress.report(
          new vscode.LanguageModelTextPart(
            formatBizError(e.bizCode, e.bizMsg, e.bizData),
          ),
        );
        return;
      }
      throw e;
    } finally {
      abort.dispose();
    }

    if (token.isCancellationRequested) {
      progress.report(
        new vscode.LanguageModelTextPart("⏹️ Cancelled by user."),
      );
      return;
    }

    // If thinking was collected but no answer text came (e.g. tool call only),
    // emit the thinking block now.
    if (thinkingStarted && !contentStarted && thinkingText) {
      if (vscode.LanguageModelThinkingPart) {
        progress.report(
          new vscode.LanguageModelThinkingPart(
            thinkingText,
            "thinking-0",
            undefined,
          ),
        );
      } else {
        const formatted = thinkingText.replace(/\n/g, "\n> ");
        progress.report(
          new vscode.LanguageModelTextPart(
            `> 💭 **Thinking**\n> \n> ${formatted}\n\n`,
          ),
        );
      }
      await new Promise((r) => setImmediate(r));
    }

    // Parse tool calls if tools are present and emit them as ToolCallPart.
    // Text was already streamed above; only emit tool calls here.
    if (hasTools) {
      const toolCalls = parseToolCalls(fullText);
      for (const tc of toolCalls) {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch (e) {
          console.error(
            `[ai-free-vscode] Failed to parse tool call arguments: ${tc.function.arguments}`,
            e,
          );
        }
        // Fix: model sometimes generates invalid endLine values
        if (
          "endLine" in input &&
          (input.endLine < 1 || input.endLine < (input.startLine ?? 1))
        ) {
          console.warn(
            `[ai-free-vscode] Invalid endLine value detected: ${input.endLine}. Setting to MAX_LINES.`,
          );
          input.endLine = 9999;
        }
        progress.report(
          new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input),
        );
      }
    }

    console.error(`[ai-free-vscode] done. fullText len=${fullText.length}`);
  }

  /** Approximate token count (1 token ≈ 4 characters) */
  async provideTokenCount(_model, textOrMessage, _token) {
    const text =
      typeof textOrMessage === "string"
        ? textOrMessage
        : (textOrMessage.content ?? [])
            .map((p) => {
              // Use duck-typing instead of instanceof to avoid ESM interop issues
              if (typeof p === "string") return p;
              if (p && typeof p.value === "string") return p.value;
              return "";
            })
            .join("");
    return Math.ceil(text.length / 4);
  }
}

function tokenToAbort(token) {
  const controller = new AbortController();
  if (token?.isCancellationRequested) {
    controller.abort();
    return { signal: controller.signal, dispose: () => {} };
  }

  const sub = token.onCancellationRequested(() => controller.abort());
  return {
    signal: controller.signal,
    dispose: () => sub.dispose(),
  };
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    error?.code === "ABORT_ERR" ||
    /abort/i.test(String(error?.message || ""))
  );
}

/**
 * Registers the unified AI Free VSCode LM provider in VS Code.
 */
export function registerLmProvider(context, deepseekAuth, qwenAuth) {
  if (!vscode.lm?.registerLanguageModelChatProvider) {
    console.warn(
      "AI Free VSCode LM Provider: vscode.lm.registerLanguageModelChatProvider is not available.",
    );
    return;
  }

  const provider = new AiFreeVscodeChatModelProvider(deepseekAuth, qwenAuth);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
  );
}
