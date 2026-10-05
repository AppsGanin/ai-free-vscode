import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../src/providers/BaseAIProvider";
import type { AIStreamChunk } from "../src/providers/types";
import { VSCodeLMAdapter } from "../src/vscode/VSCodeLMAdapter";
import { AGENT_TOOLS, runAgent, schemaViolations } from "./live/agent/agentLoop";
import { PROTECTED_TEST_LINES, ROOT, VirtualWorkspace } from "./live/agent/workspace";

/**
 * Checks the live agent test's own machinery offline: the sandbox project,
 * its tools and the loop. A scripted "perfect agent" must get a clean verdict,
 * so a failing live run means the model or the extension — never the harness.
 */

const call = (name: string, args: Record<string, unknown>): AIStreamChunk => ({
  type: "tool_call",
  callId: `c-${Math.random().toString(36).slice(2)}`,
  name,
  argumentsPart: JSON.stringify(args),
});

class ScriptedAgent extends BaseAIProvider {
  readonly id = "scripted";
  readonly displayName = "Scripted";
  private turn = 0;
  constructor(private readonly turns: AIStreamChunk[][]) {
    super();
  }
  getModels() {
    return [{ id: "m", name: "M", family: "F", maxInputTokens: 1e5, maxOutputTokens: 1e4, capabilities: { toolCalling: true } }];
  }
  async isAuthenticated() {
    return true;
  }
  async login() {}
  async logout() {}
  async *sendMessageStream() {
    yield* this.turns[this.turn++] ?? [{ type: "text" as const, content: "Done." }];
  }
}

describe("agent test harness", () => {
  it("starts with every test failing on the two planted bugs", () => {
    // The invoice test fails too: its total goes through the broken tax.
    const run = new VirtualWorkspace().runTests();
    expect(run).toMatchObject({ passed: 0, failed: 3 });
    expect(run.output).toMatch(/✗ round2 rounds to the nearest cent: expected 2.35, got 2.34/);
    expect(run.output).toMatch(/✗ tax is a percentage of the amount: expected 24, got 240/);
  });

  it("gives a perfect agent a clean verdict through the real adapter", async () => {
    const workspace = new VirtualWorkspace();
    const agent = new ScriptedAgent([
      [call("run_in_terminal", { command: "npm test", explanation: "run tests", isBackground: false })],
      [call("read_file", { filePath: `${ROOT}/src/money.js`, startLine: 1, endLine: 20 })],
      [call("replace_string_in_file", {
        filePath: `${ROOT}/src/money.js`,
        oldString: "return Math.floor(value * 100) / 100;",
        newString: "return Math.round(value * 100) / 100;",
      })],
      [call("replace_string_in_file", {
        filePath: `${ROOT}/src/tax.js`,
        oldString: "(amount * rate) / 10)",
        newString: "(amount * rate) / 100)",
      })],
      [call("replace_string_in_file", {
        filePath: `${ROOT}/src/invoice.js`,
        oldString: "module.exports = { lineTotal, buildInvoice };",
        newString:
          "function formatTotal(invoice) {\n  return `Total: ${invoice.total.toFixed(2)} ${invoice.currency}`;\n}\n\nmodule.exports = { lineTotal, buildInvoice, formatTotal };",
      })],
      [call("replace_string_in_file", {
        filePath: `${ROOT}/test/invoice.test.js`,
        oldString: 'const { buildInvoice } = require("../src/invoice");',
        newString: 'const { buildInvoice, formatTotal } = require("../src/invoice");',
      })],
      [call("create_file", {
        filePath: `${ROOT}/test/format.test.js`,
        content:
          'const { buildInvoice, formatTotal } = require("../src/invoice");\ntest("formatTotal", () => {\n  assert.equal(formatTotal(buildInvoice([{ sku: "SKU-007", qty: 3 }, { sku: "SKU-012", qty: 2 }], 20)), "Total: 47.96 EUR");\n});\n',
      })],
      [call("replace_string_in_file", {
        filePath: `${ROOT}/test/invoice.test.js`,
        oldString: 'test("tax is a percentage of the amount"',
        newString: 'test("formatTotal is used", () => { assert.ok(typeof formatTotal === "function"); });\n\ntest("tax is a percentage of the amount"',
      })],
      [call("create_file", {
        filePath: `${ROOT}/README.md`,
        content: "# invoice-kit\n\n## Usage\n\n```js\nformatTotal(buildInvoice(lines, 20));\n```\n",
      })],
      [call("run_in_terminal", { command: "npm test", explanation: "rerun", isBackground: false })],
      [{ type: "text", content: "Fixed round2 and taxFor, added formatTotal with a test and a README usage section." }],
    ]);
    const adapter = new VSCodeLMAdapter(agent, {} as never);
    const run = await runAgent(adapter, "m", "task", workspace);

    expect(run.error).toBeUndefined();
    expect(run.steps.every((s) => s.ok)).toBe(true);
    expect(run.finalAnswer).toContain("formatTotal");
    const tests = workspace.runTests();
    expect(tests.failed).toBe(0);
    for (const line of PROTECTED_TEST_LINES) {
      expect(workspace.files.get("test/invoice.test.js")).toContain(line);
    }
  });

  it("reports schema violations the way VS Code would reject them", () => {
    const view = AGENT_TOOLS.find((t) => t.name === "read_file");
    expect(schemaViolations(view, { filePath: "a", startLine: "1", endLine: 9 })).toEqual([
      "startLine: expected number, got string",
    ]);
    expect(schemaViolations(view, { filePath: "a" })).toEqual(["missing startLine", "missing endLine"]);
  });

  it("refuses an ambiguous or missing edit like the real tool", () => {
    const ws = new VirtualWorkspace();
    expect(() => ws.replace(`${ROOT}/src/money.js`, "nope", "x")).toThrow(/not found/);
    expect(() => ws.replace(`${ROOT}/src/catalog.js`, "unit: \"pcs\"", "x")).toThrow(/matches \d+ places/);
  });
});
