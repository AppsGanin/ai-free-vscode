/**
 * Unified language model provider for VS Code.
 * Groups all providers under a single vendor «ai-free-vscode».
 *
 * API: vscode.lm.registerLanguageModelChatProvider(vendor, provider)
 * Interface: LanguageModelChatProvider
 */

import * as vscode from "vscode";
import { isAbortError, tokenToAbort } from "../utils/cancellation.mjs";
import { debug, info, error as logError, warn } from "../utils/logger.mjs";
import { convertMessages } from "../utils/messageConverter.mjs";
import { messagesToPrompt } from "../utils/promptBuilder.mjs";
import { ResponseStreamHandler } from "../utils/streamHandler.mjs";
import { convertToolSchemas } from "../utils/toolConverter.mjs";
import { getAllProviders } from "./index.mjs";

const VENDOR = "ai-free-vscode";

const MODELS = [];
const ACTIVE_ABORTS = new Set();

/**
 * Force-cancels all currently active LM requests.
 * Used as a fallback when VS Code stop command is observed but cancellation
 * token does not propagate for some reason.
 */
export function forceStopAllActiveRequests(reason = "manual_stop_command") {
  let count = 0;
  for (const abort of ACTIVE_ABORTS) {
    try {
      abort.cancel();
      count++;
    } catch {
      // ignore individual failures and continue
    }
  }
  if (count > 0) {
    info(`[FORCE_STOP_ALL] reason=${reason} cancelled=${count}`);
  }
  return count;
}

// Dynamically load models from all providers
try {
  const providers = getAllProviders();
  providers.forEach(({ provider }) => {
    MODELS.push(...provider.getModels());
  });
} catch (e) {
  console.error(`Failed to load provider models: ${e.message}`);
}

class AiFreeVscodeChatModelProvider {
  /**
   * @param {Record<string, object>} authMap  family → mutable auth object
   * @param {vscode.StatusBarItem | undefined} statusBar
   */
  constructor(authMap, statusBar) {
    this._authMap = authMap;
    this._statusBar = statusBar;
  }

  _getAuthForFamily(family) {
    if (family in this._authMap) return this._authMap[family];
    throw new Error(`Unsupported model family: ${family}`);
  }

  _setStatusBar(text, tooltip) {
    if (!this._statusBar) return;
    this._statusBar.text = text;
    if (tooltip) this._statusBar.tooltip = tooltip;
    this._statusBar.show();
  }

  _hideStatusBar() {
    this._statusBar?.hide();
  }

  /** Returns the list of models. */
  provideLanguageModelChatInformation(_options, _token) {
    return MODELS;
  }

  /** Handles a request and streams the response via progress.report(). */
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
      0,
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
    const messagesCount = messages.length;

    const abort = tokenToAbort(token);
    ACTIVE_ABORTS.add(abort);
    let stopRequested = false;
    const stopSub = token.onCancellationRequested(() => {
      stopRequested = true;
      info(`[STOP_REQUESTED] model=${model.id} family=${model.family}`);
      abort.cancel();
    });

    info(
      `model=${model.id} family=${model.family} messages=${messages.length} tools=${tools.length}`,
    );
    debug(`[PROMPT]\n${prompt}`);
    this._setStatusBar(
      `$(sync~spin) ${model.name ?? model.id}`,
      `AI Free VSCode — generating with ${model.id}…`,
    );

    const handler = new ResponseStreamHandler({
      model,
      tools,
      progress,
      token,
      abort,
      prompt,
      setStatusBar: (text, tooltip) => this._setStatusBar(text, tooltip),
    });

    const provider = getAllProviders().find(({ provider: p }) =>
      p.getModels().some((m) => m.id === model.id),
    )?.provider;

    if (!provider) {
      abort.dispose();
      this._hideStatusBar();
      throw new Error(`No provider found for model: ${model.id}`);
    }

    const auth = this._getAuthForFamily(model.family);

    const doComplete = (authToUse) =>
      provider.complete({
        modelId: model.id,
        prompt,
        auth: authToUse,
        onText: (t) => handler.onText(t),
        onThinking: (t) => handler.onThinking(t),
        signal: abort.signal,
        threadKey,
        messagesCount,
      });

    try {
      try {
        await doComplete(auth);
      } catch (firstErr) {
        if (!firstErr?.isNotSignedIn) throw firstErr;

        // Автовосстановление: перечитываем auth с диска (мог обновиться)
        info(`Token expired for ${model.family}, attempting auto-recovery`);
        let freshAuth = null;
        try {
          freshAuth = provider.loadAuth();
        } catch {}

        if (!freshAuth) throw firstErr;

        handler.reset();
        this._setStatusBar(
          `$(sync~spin) ${model.name ?? model.id}`,
          `AI Free VSCode — refreshing session…`,
        );
        info(`Retrying with fresh auth for ${model.family}`);

        await doComplete(freshAuth);

        // Обновляем общий auth-объект (мутация, а не замена ссылки), чтобы
        // изменения были видны и в extension.mjs, и в последующих запросах.
        const authObj = this._authMap[model.family];
        if (authObj) Object.assign(authObj, freshAuth);
        info(`Auto-recovery succeeded for ${model.family}`);
      }
    } catch (e) {
      if (e?.isNotSignedIn) {
        const providerName =
          model.family.charAt(0).toUpperCase() + model.family.slice(1);
        const action = await vscode.window.showWarningMessage(
          `${providerName}: session expired or not signed in.`,
          `Sign in to ${providerName}`,
        );
        if (action) {
          await vscode.commands.executeCommand(`${model.family}.login`);
        }
        progress.report(
          new vscode.LanguageModelTextPart(
            `⚠️ **Not signed in to ${providerName}.** Please run the Sign In command and try again.`,
          ),
        );
        return;
      }
      logError(`ERROR ${e?.name}: ${e?.message}`, { stack: e?.stack });
      if (isAbortError(e) && handler.toolCallAbort) {
        // Stream aborted intentionally because we emitted a tool call.
        return;
      }
      if (token.isCancellationRequested || isAbortError(e)) {
        progress.report(
          new vscode.LanguageModelTextPart("⏹️ Cancelled by user."),
        );
        return;
      }
      if (e?.isBizError || e?.isToastError) {
        warn(`Provider error: ${e.bizMsg ?? e.toastMsg}`);
      }
      const providerMsg = provider?.mapError(e);
      if (providerMsg != null) {
        progress.report(new vscode.LanguageModelTextPart(providerMsg));
        return;
      }
      throw e;
    } finally {
      stopSub.dispose();
      ACTIVE_ABORTS.delete(abort);
      handler.clearThinkingWatchdog();
      abort.dispose();
      this._hideStatusBar();
    }

    // We intentionally aborted after emitting a tool call so VS Code can
    // execute tools and call us back with real results.
    if (handler.toolCallAbort) return;

    if (token.isCancellationRequested) {
      progress.report(new vscode.LanguageModelTextPart("Cancelled by user."));
      return;
    }

    await handler.emitThinkingFallback();

    if (tools.length > 0) {
      await handler.emitRemainingToolCalls();
      this._hideStatusBar();
    }

    info(
      `[RESPONSE_COMPLETE] length=${handler.fullText.length} hasTools=${tools.length > 0} thinkingLen=${handler.thinkingText.length}`,
    );
    if (tools.length > 0 && handler.fullText)
      debug(`[FULL_RESPONSE]\n${handler.fullText}`);

    handler.reportUsage();
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
    const count = Math.ceil(text.length / 4);
    return count;
  }
}

/**
 * Registers the unified AI Free VSCode LM provider in VS Code.
 */
export function registerLmProvider(context, authMap, statusBar) {
  if (!vscode.lm?.registerLanguageModelChatProvider) {
    warn("vscode.lm.registerLanguageModelChatProvider is not available.");
    return;
  }

  const provider = new AiFreeVscodeChatModelProvider(authMap, statusBar);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
  );
}
