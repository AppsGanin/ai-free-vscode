/**
 * Stateful handler for streaming LM responses.
 *
 * Encapsulates all per-request streaming state: text accumulation, thinking
 * blocks, tool-call detection/emission, stream filters, and usage reporting.
 * Designed to be instantiated once per provideLanguageModelChatResponse call.
 */

import * as vscode from "vscode";
import { debug, info, warn } from "./logger.mjs";
import { createStreamFilter } from "./streamFilter.mjs";
import { parseToolCalls } from "./toolCallParser.mjs";
import { fixLineRangeParams, parseToolArguments } from "./toolConverter.mjs";

// Abort if thinking phase exceeds this duration with no answer text
const THINKING_TIMEOUT_MS = 90_000;

export class ResponseStreamHandler {
  /**
   * @param {{
   *   model: object,
   *   tools: Array,
   *   progress: vscode.Progress,
   *   token: vscode.CancellationToken,
   *   abort: { signal: AbortSignal, cancel: () => void },
   *   setStatusBar: (text: string, tooltip?: string) => void,
   * }} opts
   */
  constructor({ model, tools, progress, token, abort, setStatusBar, prompt }) {
    this._model = model;
    this._tools = tools;
    this._hasTools = tools.length > 0;
    this._progress = progress;
    this._token = token;
    this._abort = abort;
    this._setStatusBar = setStatusBar;
    this._promptTokens = Math.ceil((prompt?.length ?? 0) / 4);
    this._lastReportedLen = 0;

    // Public state read by lmProvider after completion
    this.fullText = "";
    this.thinkingText = "";
    this.toolScanText = "";
    this.toolCallAbort = false;

    // Private stream state
    this._emittedToolCallKeys = new Set();
    this._streamFilter = createStreamFilter();
    this._thinkingFilter = createStreamFilter();
    this._thinkingStarted = false;
    this._thinkingStreamed = false;
    this._contentStarted = false;
    this._thinkingWatchdog = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  clearThinkingWatchdog() {
    if (this._thinkingWatchdog) {
      clearTimeout(this._thinkingWatchdog);
      this._thinkingWatchdog = null;
    }
  }

  /** Resets all streaming state for a retry attempt. */
  reset() {
    this.fullText = "";
    this.toolScanText = "";
    this.thinkingText = "";
    this.toolCallAbort = false;
    this._lastReportedLen = 0;
    this._emittedToolCallKeys.clear();
    this._streamFilter.reset();
    this._thinkingFilter.reset();
    this.clearThinkingWatchdog();
    this._thinkingStarted = false;
    this._thinkingStreamed = false;
    this._contentStarted = false;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  async _flushStream(text) {
    if (!text) return;
    if (this._thinkingStarted && !this._contentStarted) {
      this._contentStarted = true;
      this.clearThinkingWatchdog();
      // Fallback only: if ThinkingPart API was unavailable, emit blockquote now
      if (!this._thinkingStreamed && this.thinkingText) {
        const formatted = this.thinkingText.replace(/\n/g, "\n> ");
        this._progress.report(
          new vscode.LanguageModelTextPart(
            `> 💭 **Thinking**\n> \n> ${formatted}\n\n---\n\n`,
          ),
        );
        await new Promise((r) => setImmediate(r));
      }
    }
    this._progress.report(new vscode.LanguageModelTextPart(text));
    await new Promise((r) => setImmediate(r));
  }

  async _emitParsedToolCalls(calls) {
    for (const tc of calls) {
      const key = `${tc.function.name}::${tc.function.arguments}`;
      if (this._emittedToolCallKeys.has(key)) continue;
      this._emittedToolCallKeys.add(key);

      const input = parseToolArguments(tc.function.arguments, tc.function.name);
      fixLineRangeParams(input, tc.function.name);

      debug(
        `[TOOL_CALL_EMIT_STREAM] ${tc.function.name} args=${JSON.stringify(input)}`,
      );
      this._setStatusBar(
        `$(tools) ${tc.function.name}`,
        `AI Free VSCode — executing: ${tc.function.name}`,
      );
      this._progress.report(
        new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input),
      );
    }
  }

  /**
   * Emit any newly-detected tool calls and — if any were emitted — abort the
   * stream so VS Code can execute the tool and call us back with real results.
   */
  async _checkAndEmitToolCalls() {
    const calls = parseToolCalls(this.toolScanText);
    const before = this._emittedToolCallKeys.size;
    await this._emitParsedToolCalls(calls);
    const after = this._emittedToolCallKeys.size;
    if (after > before) {
      this.toolCallAbort = true;
      this._abort.cancel();
    }
  }

  // ── Public stream callbacks ───────────────────────────────────────────────

  async onText(text) {
    if (this._token.isCancellationRequested || this._abort.signal.aborted) {
      this._abort.cancel();
      return;
    }
    this.fullText += text;
    if (this._hasTools) {
      this.toolScanText += text;
      await this._checkAndEmitToolCalls();
      if (this.toolCallAbort) return;
    }
    debug(`[CHUNK] ${JSON.stringify(text)}`);
    // Feed a synthetic newline when the response opens with bare JSON so the
    // \n{"name": fence detection fires correctly.
    if (this._hasTools && this._streamFilter.inToolCall === false) {
      const trimmed = this.fullText.trimStart();
      if (
        trimmed.startsWith('{"name":') ||
        trimmed.startsWith('{"name" :') ||
        trimmed.startsWith('"name":') ||
        trimmed.startsWith('"name" :') ||
        trimmed.startsWith('name":') ||
        trimmed.startsWith('name" :')
      ) {
        this._streamFilter.feed("\n");
      }
    }
    const safe = this._streamFilter.feed(text);
    if (safe) await this._flushStream(safe);
    this._maybePeriodicallyReportUsage();
  }

  async onThinking(text) {
    if (this._token.isCancellationRequested || this._abort.signal.aborted) {
      this._abort.cancel();
      return;
    }
    if (this._hasTools) {
      this.toolScanText += text;
      await this._checkAndEmitToolCalls();
      if (this.toolCallAbort) return;
    }
    debug(`[THINK] ${JSON.stringify(text)}`);
    if (!this._thinkingStarted) {
      this._thinkingStarted = true;
      this._thinkingWatchdog = setTimeout(() => {
        warn(
          `[THINK_TIMEOUT] thinking exceeded ${THINKING_TIMEOUT_MS / 1000}s without answer — aborting`,
        );
        this._abort.cancel();
      }, THINKING_TIMEOUT_MS);
    }
    // Suppress tool_call markup leaking into thinking stream
    if (this._hasTools && this._thinkingFilter.inToolCall === false) {
      const trimmed = text.trimStart();
      if (
        trimmed.startsWith('{"name":') ||
        trimmed.startsWith('{"name" :') ||
        trimmed.startsWith('"name":') ||
        trimmed.startsWith('"name" :') ||
        trimmed.startsWith('name":') ||
        trimmed.startsWith('name" :')
      ) {
        this._thinkingFilter.feed("\n");
      }
    }
    const safeThinking = this._thinkingFilter.feed(text);
    if (!safeThinking) return;

    this.thinkingText += safeThinking;
    if (vscode.LanguageModelThinkingPart) {
      this._progress.report(new vscode.LanguageModelThinkingPart(safeThinking));
      this._thinkingStreamed = true;
      await new Promise((r) => setImmediate(r));
    }
    this._maybePeriodicallyReportUsage();
  }

  // ── Post-completion helpers ───────────────────────────────────────────────

  /**
   * If thinking was collected but no answer text came (e.g. tool-call only),
   * emit the blockquote fallback now.
   */
  async emitThinkingFallback() {
    if (
      this._thinkingStarted &&
      !this._contentStarted &&
      !this._thinkingStreamed &&
      this.thinkingText
    ) {
      const formatted = this.thinkingText.replace(/\n/g, "\n> ");
      this._progress.report(
        new vscode.LanguageModelTextPart(
          `> 💭 **Thinking**\n> \n> ${formatted}\n\n`,
        ),
      );
      await new Promise((r) => setImmediate(r));
    }
  }

  /** Parse and emit any tool calls not yet emitted during streaming. */
  async emitRemainingToolCalls() {
    debug(`[FULL_RESPONSE]\n${this.fullText}`);
    const toolCalls = parseToolCalls(this.toolScanText);
    await this._emitParsedToolCalls(toolCalls);

    if (toolCalls.length === 0 && this.toolScanText.includes("tool_call")) {
      warn(
        `tool_call detected in response but parseToolCalls returned 0. Snippet: ${this.toolScanText.slice(0, 300)}`,
      );
    }
    info(
      `Parsed ${toolCalls.length} tool call(s), emitted ${this._emittedToolCallKeys.size}`,
    );
  }

  _maybePeriodicallyReportUsage() {
    const len = this.fullText.length + this.thinkingText.length;
    if (len - this._lastReportedLen >= 250) {
      this.reportUsage();
    }
  }

  /**
   * Report token usage so VS Code can display the context window indicator.
   * The MIME type 'usage' is the internal contract used by VS Code's
   * chatContextUsageWidget (see endpointTypes.ts in vscode repo).
   */
  reportUsage() {
    if (!vscode.LanguageModelDataPart) return;
    const completionTokens = Math.ceil(
      (this.fullText.length + this.thinkingText.length) / 4,
    );
    const usage = {
      prompt_tokens: this._promptTokens,
      completion_tokens: completionTokens,
      total_tokens: this._promptTokens + completionTokens,
    };
    debug(
      `[USAGE] prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}`,
    );
    this._progress.report(
      new vscode.LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(usage)),
        "usage",
      ),
    );
    this._lastReportedLen = this.fullText.length + this.thinkingText.length;
  }
}
