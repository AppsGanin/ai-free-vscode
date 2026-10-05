import { createContext, runInContext } from "node:vm";

/**
 * A small JavaScript project in memory, with the tools Copilot's agent uses
 * on a real one. The agent test hands these to a model and judges the run by
 * what the project looks like afterwards — not by what the model says.
 */

export const ROOT = "/workspace/invoice-kit";

const CATALOG_SIZE = 160;

function catalogFile(): string {
  const rows: string[] = [];
  for (let i = 1; i <= CATALOG_SIZE; i++) {
    const sku = `SKU-${String(i).padStart(3, "0")}`;
    // Two prices the tests rely on; the rest is filler that makes the file
    // long enough to need ranged reads.
    const price = i === 7 ? 4.99 : i === 12 ? 12.5 : Math.round((i * 1.37 + 0.49) * 100) / 100;
    rows.push(`  "${sku}": { name: "Catalog item ${i}", price: ${price}, unit: "pcs" },`);
  }
  return [
    "// Product catalog: SKU → name, unit price in EUR.",
    "// Generated from the ERP export; do not edit prices by hand.",
    "const CATALOG = {",
    ...rows,
    "};",
    "",
    "module.exports = { CATALOG };",
    "",
  ].join("\n");
}

export const INITIAL_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "invoice-kit",
      version: "1.0.0",
      description: "Builds invoices from catalog SKUs",
      scripts: { test: "node test/run.js" },
    },
    null,
    2,
  ) + "\n",
  "README.md": "# invoice-kit\n\nBuilds invoices (subtotal, tax, total) from catalog SKUs.\n",
  "src/money.js": [
    "// Money helpers. Amounts are plain numbers in currency units.",
    "",
    "/** Rounds to cents. */",
    "function round2(value) {",
    "  return Math.floor(value * 100) / 100;",
    "}",
    "",
    "function sum(values) {",
    "  return values.reduce((total, v) => total + v, 0);",
    "}",
    "",
    "module.exports = { round2, sum };",
    "",
  ].join("\n"),
  "src/tax.js": [
    'const { round2 } = require("./money");',
    "",
    "/** Tax on `amount`; `rate` is a percentage, e.g. 20 for 20 %. */",
    "function taxFor(amount, rate) {",
    "  return round2((amount * rate) / 10);",
    "}",
    "",
    "module.exports = { taxFor };",
    "",
  ].join("\n"),
  "src/invoice.js": [
    'const { round2, sum } = require("./money");',
    'const { taxFor } = require("./tax");',
    'const { CATALOG } = require("./catalog");',
    "",
    "function lineTotal(line) {",
    "  const item = CATALOG[line.sku];",
    "  if (!item) throw new Error(`Unknown SKU: ${line.sku}`);",
    "  return round2(item.price * line.qty);",
    "}",
    "",
    "function buildInvoice(lines, taxRate) {",
    "  const subtotal = round2(sum(lines.map(lineTotal)));",
    "  const tax = taxFor(subtotal, taxRate);",
    '  return { lines, subtotal, tax, total: round2(subtotal + tax), currency: "EUR" };',
    "}",
    "",
    "module.exports = { lineTotal, buildInvoice };",
    "",
  ].join("\n"),
  "src/catalog.js": catalogFile(),
  "test/invoice.test.js": [
    'const { round2 } = require("../src/money");',
    'const { taxFor } = require("../src/tax");',
    'const { buildInvoice } = require("../src/invoice");',
    "",
    'test("round2 rounds to the nearest cent", () => {',
    "  assert.equal(round2(2.346), 2.35);",
    "  assert.equal(round2(10.004), 10);",
    "});",
    "",
    'test("tax is a percentage of the amount", () => {',
    "  assert.equal(taxFor(120, 20), 24);",
    "});",
    "",
    'test("invoice adds tax to the subtotal", () => {',
    '  const invoice = buildInvoice([{ sku: "SKU-007", qty: 3 }, { sku: "SKU-012", qty: 2 }], 20);',
    "  assert.equal(invoice.subtotal, 39.97);",
    "  assert.equal(invoice.tax, 7.99);",
    "  assert.equal(invoice.total, 47.96);",
    "});",
    "",
  ].join("\n"),
  "test/run.js": "// Test runner: loads every *.test.js under test/.\n",
};

/** Lines of the original tests that must survive: fixing code, not tests. */
export const PROTECTED_TEST_LINES = [
  "assert.equal(round2(2.346), 2.35);",
  "assert.equal(round2(10.004), 10);",
  "assert.equal(taxFor(120, 20), 24);",
  "assert.equal(invoice.subtotal, 39.97);",
  "assert.equal(invoice.tax, 7.99);",
  "assert.equal(invoice.total, 47.96);",
];

export interface TestRun {
  passed: number;
  failed: number;
  output: string;
}

export class VirtualWorkspace {
  readonly files = new Map<string, string>(Object.entries(INITIAL_FILES));

  /** `/workspace/invoice-kit/src/a.js`, `src/a.js`, `./src/a.js` → `src/a.js`. */
  rel(path: string): string {
    let p = String(path ?? "").trim().replace(/\\/g, "/");
    if (p.startsWith(ROOT)) p = p.slice(ROOT.length);
    return p.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  }

  listDir(path: string): string {
    const dir = this.rel(path);
    const prefix = dir ? `${dir}/` : "";
    const entries = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      entries.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    if (entries.size === 0) throw new Error(`No such directory: ${path}`);
    return [...entries].sort().join("\n");
  }

  readFile(path: string, startLine?: number, endLine?: number): string {
    const file = this.rel(path);
    const content = this.files.get(file);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    const lines = content.split("\n");
    const start = Math.max(1, Math.floor(startLine ?? 1));
    const end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
    const body = lines.slice(start - 1, end).join("\n");
    return end < lines.length || start > 1
      ? `File: ${ROOT}/${file}. Lines ${start} to ${end} (${lines.length} lines total):\n${body}`
      : body;
  }

  grep(query: string, isRegexp = false): string {
    let pattern: RegExp;
    try {
      pattern = isRegexp
        ? new RegExp(query)
        : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } catch {
      throw new Error(`Invalid regular expression: ${query}`);
    }
    const hits: string[] = [];
    for (const [file, content] of this.files) {
      content.split("\n").forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${ROOT}/${file}:${i + 1}: ${line.trim()}`);
      });
    }
    return hits.slice(0, 40).join("\n") || "No matches found.";
  }

  replace(path: string, oldString: string, newString: string): string {
    const file = this.rel(path);
    const content = this.files.get(file);
    if (content === undefined) throw new Error(`File not found: ${path}`);
    const count = oldString ? content.split(oldString).length - 1 : 0;
    if (count === 0) {
      throw new Error("oldString not found in the file. Read the file again and copy the exact text, including whitespace.");
    }
    if (count > 1) {
      throw new Error(`oldString matches ${count} places; include more surrounding lines so it is unique.`);
    }
    this.files.set(file, content.replace(oldString, newString));
    return `Edited ${ROOT}/${file}.`;
  }

  createFile(path: string, content: string): string {
    const file = this.rel(path);
    this.files.set(file, String(content ?? ""));
    return `Created ${ROOT}/${file}.`;
  }

  /** `npm test`. The project's modules run sandboxed: no Node APIs, no I/O. */
  runTests(): TestRun {
    const results: string[] = [];
    let passed = 0;
    let failed = 0;
    const testFiles = [...this.files.keys()].filter((f) => /^test\/.*\.test\.js$/.test(f));

    for (const testFile of testFiles) {
      const tests: Array<{ name: string; fn: () => void }> = [];
      const assert = {
        equal(actual: unknown, expected: unknown) {
          if (actual !== expected) {
            throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
          }
        },
        ok(value: unknown, message?: string) {
          if (!value) throw new Error(message ?? `expected a truthy value, got ${JSON.stringify(value)}`);
        },
        deepEqual(actual: unknown, expected: unknown) {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
          }
        },
      };
      try {
        const load = this.moduleLoader({ test: (name: string, fn: () => void) => tests.push({ name, fn }), assert });
        load(testFile);
      } catch (err) {
        failed++;
        results.push(`✗ ${testFile} failed to load: ${(err as Error).message}`);
        continue;
      }
      for (const t of tests) {
        try {
          t.fn();
          passed++;
          results.push(`✓ ${t.name}`);
        } catch (err) {
          failed++;
          results.push(`✗ ${t.name}: ${(err as Error).message}`);
        }
      }
    }
    results.push(`\n${passed} passing, ${failed} failing`);
    return { passed, failed, output: results.join("\n") };
  }

  /** A CommonJS loader over the virtual files, inside one vm context. */
  moduleLoader(globals: Record<string, unknown> = {}): (file: string) => Record<string, unknown> {
    const context = createContext({ ...globals, console: { log() {} } });
    const cache = new Map<string, { exports: Record<string, unknown> }>();
    const load = (file: string): Record<string, unknown> => {
      const cached = cache.get(file);
      if (cached) return cached.exports;
      const source = this.files.get(file);
      if (source === undefined) throw new Error(`Cannot find module '${file}'`);
      const module = { exports: {} as Record<string, unknown> };
      cache.set(file, module);
      const fn = runInContext(
        `(function (require, module, exports) {\n${source}\n})`,
        context,
        { timeout: 1000, filename: file },
      ) as (r: (s: string) => unknown, m: typeof module, e: unknown) => void;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      fn((spec: string) => load(resolve(dir, spec)), module, module.exports);
      return module.exports;
    };
    return load;
  }

  /** What `run_in_terminal` can do here. */
  runCommand(command: string): string {
    const cmd = command.trim();
    if (/^(cd \S+\s*&&\s*)?(npm (run )?test|npx \S*test|node test\/run\.js|yarn test|pnpm test)\b/.test(cmd)) {
      const run = this.runTests();
      return `> invoice-kit@1.0.0 test\n> node test/run.js\n\n${run.output}`;
    }
    const cat = /^(cd \S+\s*&&\s*)?cat\s+(\S+)$/.exec(cmd);
    if (cat) return this.readFile(cat[2]);
    const ls = /^(cd \S+\s*&&\s*)?ls(\s+-\w+)*\s*(\S+)?$/.exec(cmd);
    if (ls) return this.listDir(ls[3] ?? "");
    return `Command not available in this sandbox: ${cmd}. Use npm test to run the tests.`;
  }
}

function resolve(dir: string, spec: string): string {
  const parts = (spec.startsWith(".") ? `${dir}/${spec}` : spec).split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const path = out.join("/");
  return path.endsWith(".js") ? path : `${path}.js`;
}
