import { describe, expect, it } from "vitest";
import { StreamingToolCallRouter } from "../../src/providers/common/StreamingToolCallRouter";
import type { AIStreamChunk } from "../../src/providers/types";

function run(text: string, size = 5, allowToolCalls = true) {
  const router = new StreamingToolCallRouter(allowToolCalls);
  const out: AIStreamChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    if (router.cut) break;
    out.push(...router.route(text.slice(i, i + size)));
  }
  out.push(...router.finish());
  return {
    cut: router.cut,
    text: out.map((c) => (c.type === "text" ? c.content : "")).join(""),
    calls: out.filter((c) => c.type === "tool_call").length,
  };
}

describe("transcript guard", () => {
  // Small models keep "playing" the dialog after their answer. Everything
  // after a fabricated turn is dropped — and the upstream is stopped.
  it.each([
    ["a fabricated user turn", "The answer is 4.\nUser: and 5+5?\nAssistant: 10"],
    ["our tool-result placeholder", "Reading it now.\n[Tool result id=call_1] {...}"],
    ["an echoed call id", "Done.\nEnvironment: [toolu_bdrk_018gnVobTxyz]"],
  ])("cuts at %s", (_label, text) => {
    const result = run(text);
    expect(result.cut).toBe(true);
    expect(result.text.trim()).toBe(text.split("\n")[0]);
  });

  it("does not cut on the same words inside a code block", () => {
    const text = "Config:\n```yaml\nUser: admin\nAssistant: bot\n```\nDone.";
    const result = run(text);
    expect(result.cut).toBe(false);
    expect(result.text).toBe(text);
  });

  it("does not cut on an indented or lower-case key", () => {
    const text = "Fields:\n  user: 1\nuser: 2\nEnd.";
    expect(run(text).text).toBe(text);
  });
});

describe("protocol leftovers", () => {
  it("strips a stray closing tag the model dropped into prose", () => {
    expect(run("All good.</tool_call>\nNext step.", 3).text).toBe("All good.Next step.");
  });

  it("strips stray Anthropic-dialect closers too (#16)", () => {
    expect(run("Reading.\n</invoke>\n</function_calls>\nDone.", 2).text).toBe("Reading.\nDone.");
  });

  it("emits text as-is when tool calls are not allowed", () => {
    const text = '```tool_call\n{"name":"x","arguments":{}}\n```';
    const result = run(text, 4, false);
    expect(result.calls).toBe(0);
    expect(result.text).toBe(text);
  });

  it("releases a long false-positive hold unchanged", () => {
    // A JSON-ish opening that never turns into a call must not swallow the
    // rest of the answer.
    const text = "{ " + "lorem ipsum ".repeat(600);
    const result = run(text, 50);
    expect(result.calls).toBe(0);
    expect(result.text).toBe(text);
  });
});
