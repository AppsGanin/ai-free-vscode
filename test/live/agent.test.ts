import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setOutputChannel } from "../../src/logger";
import { setSetting } from "../mocks/vscode";
import type { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import { DeepSeekProvider } from "../../src/providers/deepseek/DeepSeekProvider";
import { KimiProvider } from "../../src/providers/kimi/KimiProvider";
import { QwenProvider } from "../../src/providers/qwen/QwenProvider";
import { ZaiProvider } from "../../src/providers/zai/ZaiProvider";
import { VSCodeLMAdapter } from "../../src/vscode/VSCodeLMAdapter";
import { type AgentRun, runAgent } from "./agent/agentLoop";
import { PROTECTED_TEST_LINES, ROOT, VirtualWorkspace } from "./agent/workspace";
import {
  type LiveProvider,
  SIGN_IN_TIMEOUT_MS,
  memorySecrets,
  readSession,
  unavailable,
} from "./session";

/**
 * Full agent sessions, end to end: each model gets a small project with two
 * bugs and a multi-part task, and works through it with Copilot's tools for
 * dozens of steps. Passing means the project is actually right afterwards —
 * tests green, the new function correct, nothing cheated — and the protocol
 * held up the whole way.
 *
 *   npm run test:live -- test/live/agent.test.ts            all providers
 *   npm run test:live -- test/live/agent.test.ts -t kimi     one of them
 *
 * A per-step transcript of each run is written to test/live/.reports/.
 */

const TASK = `You are working in the project at ${ROOT} (a small Node.js library).
Use the tools to inspect and change the files — do not just describe changes.

1. Run the project's tests (npm test) and see what fails.
2. Find and fix the bugs in src/ that make the tests fail. Do NOT change the existing tests.
3. Add a function formatTotal(invoice) to src/invoice.js that returns a string like "Total: 47.96 EUR" — the total with exactly two decimals, then the invoice's currency — and export it.
4. Add a test for formatTotal to test/invoice.test.js.
5. Run the tests again and keep fixing until every test passes.
6. Add a "## Usage" section to README.md with a short example that calls formatTotal.

When everything is done, reply with a short summary of what you changed.`;

interface Suite {
  provider: LiveProvider;
  create: () => BaseAIProvider;
  model: string;
}

const SUITES: Suite[] = [
  { provider: "qwen", create: () => new QwenProvider(), model: "qwen3.8-max" },
  { provider: "deepseek", create: () => new DeepSeekProvider(), model: "deepseek-default" },
  // Kimi's own server-side tools are handed to ours or refused (KimiApiClient).
  { provider: "kimi", create: () => new KimiProvider(), model: "kimi-instant" },
  { provider: "zai", create: () => new ZaiProvider(), model: "glm-5.3" },
  { provider: "zai", create: () => new ZaiProvider(), model: "glm-4.7" },
];

// Overload and anti-bot throttling on the service's side — not our code.
const UPSTREAM_BUSY =
  /at capacity|rate[ _]limit|too many requests|messages too frequent|server is busy|anti-bot \(Alibaba Cloud WAF\)/i;
const REPORT_DIR = join(__dirname, ".reports");

const LOG: string[] = [];
setOutputChannel({ appendLine: (line: string) => LOG.push(line) } as never);
// Full DEBUG log in the reports: stream phases, send retries, rewrites.
setSetting("debug", true);

/** What the project must look like after a successful session. */
function judge(workspace: VirtualWorkspace) {
  const tests = workspace.runTests();
  let formatTotal: string | undefined;
  let formatError: string | undefined;
  try {
    const invoiceModule = workspace.moduleLoader()("src/invoice.js") as {
      buildInvoice: (lines: unknown[], rate: number) => unknown;
      formatTotal?: (invoice: unknown) => unknown;
    };
    const invoice = invoiceModule.buildInvoice(
      [{ sku: "SKU-007", qty: 3 }, { sku: "SKU-012", qty: 2 }],
      20,
    );
    formatTotal = String(invoiceModule.formatTotal?.(invoice));
  } catch (err) {
    formatError = (err as Error).message;
  }
  const testFile = workspace.files.get("test/invoice.test.js") ?? "";
  return {
    tests,
    formatTotal,
    formatError,
    keptOriginalTests: PROTECTED_TEST_LINES.filter((line) => !testFile.includes(line)),
    addedFormatTest: /formatTotal/.test(testFile),
    readmeUsage: /##\s*Usage[\s\S]*formatTotal/i.test(workspace.files.get("README.md") ?? ""),
  };
}

function report(suite: Suite, run: AgentRun, verdict: ReturnType<typeof judge>, log: string[]): string {
  const lines = [
    `# ${suite.provider} / ${suite.model}`,
    "",
    `- turns: ${run.turns}, tool calls: ${run.steps.length} (failed: ${run.steps.filter((s) => !s.ok).length}), time: ${Math.round(run.ms / 1000)} s`,
    `- schema violations: ${run.steps.filter((s) => s.violations.length).length}`,
    `- reasoning after answer: ${run.reasoningAfterAnswer}, protocol leaks: ${run.leaks.length}`,
    `- tests: ${verdict.tests.passed} passing, ${verdict.tests.failed} failing`,
    `- formatTotal: ${verdict.formatTotal ?? verdict.formatError}`,
    `- README usage: ${verdict.readmeUsage}, test added: ${verdict.addedFormatTest}, original tests intact: ${verdict.keptOriginalTests.length === 0}`,
    run.error ? `- error: ${run.error}` : "",
    "",
    "## Steps",
    ...run.steps.map(
      (s, i) =>
        `${i + 1}. [turn ${s.turn}] \`${s.tool}\` ${JSON.stringify(s.args).slice(0, 160)} → ${s.ok ? "ok" : "**" + s.result + "**"}`,
    ),
    "",
    "## Final answer",
    run.finalAnswer || "(none)",
    "",
    ...(run.leaks.length ? ["## Leaks", ...run.leaks, ""] : []),
    "## Extension log (tail)",
    "```",
    ...log.slice(-80),
    "```",
  ];
  return lines.join("\n");
}

for (const suite of SUITES) {
  const reason = unavailable(suite.provider);

  describe.skipIf(reason)(`agent session: ${suite.provider} / ${suite.model}`, () => {
    let provider: BaseAIProvider;
    let adapter: VSCodeLMAdapter;

    beforeAll(async () => {
      const session = await readSession(suite.provider);
      if (!session) throw new Error(`${suite.provider}: not signed in`);
      provider = suite.create();
      adapter = new VSCodeLMAdapter(provider, memorySecrets(session) as never);
    }, SIGN_IN_TIMEOUT_MS + 120_000);

    afterAll(async () => {
      provider?.dispose();
      // Let the browser release the profile before the next suite opens it.
      await new Promise((resolve) => setTimeout(resolve, 3000));
    });

    it("fixes the project over a long tool-driven session", async (ctx) => {
      const workspace = new VirtualWorkspace();
      const from = LOG.length;
      const run = await runAgent(adapter, suite.model, TASK, workspace, {
        maxTurns: 45,
        onTurn: (line) => console.log(`[${suite.provider}/${suite.model}] ${line}`),
      });
      const verdict = judge(workspace);

      mkdirSync(REPORT_DIR, { recursive: true });
      const file = join(REPORT_DIR, `agent-${suite.provider}-${suite.model}.md`);
      writeFileSync(file, report(suite, run, verdict, LOG.slice(from)));
      console.log(`[${suite.provider}/${suite.model}] report: ${file}`);

      if (run.error && UPSTREAM_BUSY.test(run.error)) ctx.skip(`upstream busy: ${run.error}`);

      // The session ran to an end of its own.
      expect(run.error, "provider error").toBeUndefined();
      expect(run.exhausted, "ran out of turns").toBe(false);
      expect(run.finalAnswer.trim(), "final answer").not.toBe("");
      // It was a long one.
      expect(run.steps.length).toBeGreaterThanOrEqual(8);
      // The protocol held for every step.
      expect(run.steps.filter((s) => s.violations.length).map((s) => `${s.tool}: ${s.violations}`)).toEqual([]);
      expect(run.reasoningAfterAnswer, "reasoning after answer").toBe(0);
      expect(run.leaks, "protocol leaked into an answer").toEqual([]);
      // And the work is really done.
      expect(verdict.tests.failed, verdict.tests.output).toBe(0);
      expect(verdict.tests.passed).toBeGreaterThanOrEqual(4);
      expect(verdict.keptOriginalTests, "original tests weakened").toEqual([]);
      expect(verdict.formatTotal).toBe("Total: 47.96 EUR");
      expect(verdict.addedFormatTest, "formatTotal test").toBe(true);
      expect(verdict.readmeUsage, "README usage section").toBe(true);
    }, 45 * 60_000);
  });
}
