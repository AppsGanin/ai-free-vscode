import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { setOutputChannel } from "../../src/logger";
import type { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import { DeepSeekProvider } from "../../src/providers/deepseek/DeepSeekProvider";
import { KimiProvider } from "../../src/providers/kimi/KimiProvider";
import { QwenProvider } from "../../src/providers/qwen/QwenProvider";
import type { AIToolDefinition } from "../../src/providers/types";
import { ZaiProvider } from "../../src/providers/zai/ZaiProvider";
import { VSCodeLMAdapter } from "../../src/vscode/VSCodeLMAdapter";
import {
  type LiveProvider,
  SIGN_IN_TIMEOUT_MS,
  memorySecrets,
  readSession,
  unavailable,
} from "./session";

/**
 * Real requests to the real services, through the same path a chat in VS Code
 * takes: adapter → provider → upstream. Run with `npm run test:live`; each
 * provider needs its browser profile signed in (Sign In in the extension) and
 * the VS Code dev host closed, since Chrome locks a profile to one process.
 *
 * These catch what the offline tests cannot: a changed stream format, a new
 * anti-bot step, a model that stopped following the tool protocol.
 */

const VIEW: AIToolDefinition = {
  name: "view",
  description: "Read a file from the workspace, optionally only a line range",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute file path" },
      view_range: {
        type: "array",
        items: { type: "integer" },
        description: "[startLine, endLine], 1-based",
      },
    },
    required: ["path"],
  },
};

type Part = { kind: string; value?: unknown; name?: string; input?: unknown };

interface Reply {
  parts: Part[];
  text: string;
  calls: Array<{ name?: string; input?: unknown }>;
  /** Reasoning reported after the answer had begun — the chat UI folds the answer away. */
  thinkingAfterText: boolean;
}

async function ask(
  adapter: VSCodeLMAdapter,
  model: string,
  prompt: string,
  tools: AIToolDefinition[] = [],
): Promise<Reply> {
  const parts: Part[] = [];
  await adapter.provideLanguageModelChatResponse(
    { id: model } as never,
    [{ role: 1, content: [{ value: prompt }], name: undefined }] as never,
    {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
      toolMode: 1,
    } as never,
    { report: (p: Part) => parts.push(p) },
    {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    } as never,
  );
  const firstText = parts.findIndex((p) => p.kind === "text");
  return {
    parts,
    text: parts
      .filter((p) => p.kind === "text")
      .map((p) => String(p.value))
      .join(""),
    calls: parts.filter((p) => p.kind === "tool").map((p) => ({ name: p.name, input: p.input })),
    thinkingAfterText:
      firstText >= 0 && parts.slice(firstText).some((p) => p.kind === "thinking"),
  };
}

/**
 * Overload on the service side ("at capacity", rate limits) says nothing about
 * our code: the test is skipped with the reason rather than failed, so a red
 * live run always means something to fix here.
 */
// Overload and anti-bot throttling on the service's side — not our code.
const UPSTREAM_BUSY =
  /at capacity|rate[ _]limit|too many requests|messages too frequent|server is busy|anti-bot \(Alibaba Cloud WAF\)/i;

function live(
  fn: () => Promise<void>,
): (ctx: { skip: (note?: string) => void }) => Promise<void> {
  return async (ctx) => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (UPSTREAM_BUSY.test(message)) ctx.skip(`upstream busy: ${message.slice(0, 120)}`);
      throw err;
    }
  };
}

interface Suite {
  provider: LiveProvider;
  create: () => BaseAIProvider;
  /** Models exercised; the first one also runs the tool test. */
  models: string[];
  tools: boolean;
}

const SUITES: Suite[] = [
  { provider: "qwen", create: () => new QwenProvider(), models: ["qwen3.8-max"], tools: true },
  { provider: "deepseek", create: () => new DeepSeekProvider(), models: ["deepseek-default"], tools: true },
  // Kimi is kept out of chat (see README); only its plain answers are checked.
  { provider: "kimi", create: () => new KimiProvider(), models: ["kimi-instant"], tools: true },
  { provider: "zai", create: () => new ZaiProvider(), models: ["glm-5.3", "glm-4.7"], tools: true },
];

// The extension log is the first thing to read when a live test fails: the
// tail of it is printed with the failure.
const LOG: string[] = [];
setOutputChannel({ appendLine: (line: string) => LOG.push(line) } as never);
beforeEach(() => {
  const from = LOG.length;
  onTestFailed(() => {
    console.log(`--- extension log ---\n${LOG.slice(from).slice(-60).join("\n")}`);
  });
});

for (const suite of SUITES) {
  const reason = unavailable(suite.provider);

  describe.skipIf(reason)(`${suite.provider} (live)`, () => {
    let provider: BaseAIProvider;
    let adapter: VSCodeLMAdapter;

    // Long enough for the user to sign in when the profile is signed out.
    beforeAll(async () => {
      const session = await readSession(suite.provider);
      if (!session) {
        throw new Error(
          `${suite.provider}: not signed in — sign in when the browser window opens (LIVE_LOGIN_TIMEOUT=seconds to wait longer)`,
        );
      }
      provider = suite.create();
      adapter = new VSCodeLMAdapter(provider, memorySecrets(session) as never);
    }, SIGN_IN_TIMEOUT_MS + 120_000);

    afterAll(() => {
      provider?.dispose();
    });

    for (const model of suite.models) {
      it(`${model}: answers a plain question`, live(async () => {
        const reply = await ask(
          adapter,
          model,
          "Сколько будет 17*23? Ответь только числом, без пояснений.",
        );
        expect(reply.text).toContain("391");
        expect(reply.thinkingAfterText).toBe(false);
      }));

      it(`${model}: keeps the start of a long, structured answer`, live(async () => {
        const reply = await ask(
          adapter,
          model,
          "Начни ответ ровно со строки «ОТВЕТ:», затем дай 3 коротких пункта с заголовками markdown о том, зачем нужны таймауты в HTTP-запросах.",
        );
        // The visible reply used to start mid-word when reasoning was flushed
        // after the answer had begun.
        expect(reply.thinkingAfterText).toBe(false);
        // Compared as a prefix so a failure shows what the reply began with.
        expect(reply.text.trimStart().slice(0, 40)).toMatch(/^\**ОТВЕТ:/);
      }));
    }

    it.skipIf(!suite.tools)(`${suite.models[0]}: calls a tool with typed arguments`, live(async () => {
      const reply = await ask(
        adapter,
        suite.models[0],
        "Покажи строки 1-40 файла /Users/test/project/src/app.ts",
        [VIEW],
      );
      expect(reply.calls).toHaveLength(1);
      expect(reply.calls[0].name).toBe("view");
      // The schema says integer[]; a string here is rejected by VS Code.
      expect(reply.calls[0].input).toMatchObject({
        path: "/Users/test/project/src/app.ts",
        view_range: [1, 40],
      });
    }));
  });

  if (reason) {
    it.skip(`${suite.provider} (live) — skipped: ${reason}`, () => {});
  }
}
