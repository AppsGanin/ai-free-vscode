import { describe, expect, it } from "vitest";
import { StreamingToolCallRouter } from "../../src/providers/common/StreamingToolCallRouter";
import { buildToolsSystemPrompt } from "../../src/providers/common/ToolCalling";
import type { AIStreamChunk } from "../../src/providers/types";

/** Feeds `text` to a router in pieces of `size` chars, as a stream would. */
function route(text: string, size: number) {
  const router = new StreamingToolCallRouter(true);
  const out: AIStreamChunk[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(...router.route(text.slice(i, i + size)));
  }
  out.push(...router.finish());
  return {
    text: out
      .filter((c) => c.type === "text")
      .map((c) => (c as { content: string }).content)
      .join(""),
    calls: out
      .filter((c) => c.type === "tool_call")
      .map((c) => {
        const call = c as { name: string; argumentsPart: string };
        return { name: call.name, args: JSON.parse(call.argumentsPart) };
      }),
  };
}

// Chunk boundaries fall in different places at every size: inside a marker,
// inside a JSON string, inside a multi-byte character.
const SIZES = [1, 3, 7, 64, 1e9];

const BAR = "\uFF5C"; // fullwidth bar DeepSeek uses in its DSML prefix
const DSML = `<${BAR}${BAR}DSML${BAR}${BAR}`;
const DSML_CLOSE = `</${BAR}${BAR}DSML${BAR}${BAR}`;

const DIALECTS: Array<[string, string, Array<{ name: string; args: unknown }>]> = [
  [
    "fenced tool_call JSON (our protocol)",
    'Reading.\n```tool_call\n{"name":"read_file","arguments":{"filePath":"a.ts"}}\n```',
    [{ name: "read_file", args: { filePath: "a.ts" } }],
  ],
  [
    "<tool_call>{json}</tool_call>",
    '<tool_call>{"name":"read_file","arguments":{"filePath":"a.ts"}}</tool_call>',
    [{ name: "read_file", args: { filePath: "a.ts" } }],
  ],
  [
    "<tool_call name=…> attribute form",
    '<tool_call name="get_errors">{"filePaths":[]}</tool_call>',
    [{ name: "get_errors", args: { filePaths: [] } }],
  ],
  [
    "MiMo/Qwen-Coder <function=…><parameter=…>",
    "<tool_call><function=read_file><parameter=path>/a/b.ts</parameter></function></tool_call>",
    [{ name: "read_file", args: { path: "/a/b.ts" } }],
  ],
  [
    "MiMo <tool_name>/<tool_arguments>",
    '<tool_name>read_file</tool_name><tool_arguments>{"filePath":"a.ts"}</tool_arguments>',
    [{ name: "read_file", args: { filePath: "a.ts" } }],
  ],
  [
    "#16 Anthropic <invoke>, closing tags dropped",
    '<invoke name="read_file"> <parameter name="filePath">src/a.ts',
    [{ name: "read_file", args: { filePath: "src/a.ts" } }],
  ],
  [
    "#16 <function_calls> wrapper",
    '<function_calls>\n<invoke name="read_file">\n<parameter name="filePath">/a/b.ts</parameter>\n<parameter name="startLine">1</parameter>\n</invoke>\n</function_calls>',
    [{ name: "read_file", args: { filePath: "/a/b.ts", startLine: 1 } }],
  ],
  [
    "#16 namespaced <ns:invoke>",
    '<ns:invoke name="read_file"><ns:parameter name="filePath">a.ts</ns:parameter></ns:invoke>',
    [{ name: "read_file", args: { filePath: "a.ts" } }],
  ],
  [
    "#16 two calls in one block",
    '<function_calls><invoke name="a"><parameter name="p">1</parameter></invoke><invoke name="b"><parameter name="q">x</parameter></invoke></function_calls>',
    [
      { name: "a", args: { p: 1 } },
      { name: "b", args: { q: "x" } },
    ],
  ],
  [
    "#16 HTML inside a parameter value",
    '<invoke name="create_file"><parameter name="content"><div class="x">hi</div></parameter></invoke>',
    [{ name: "create_file", args: { content: '<div class="x">hi</div>' } }],
  ],
  [
    "#17 tag-only dialect",
    "<tool_call> <read_file> <path>D:\\x\\S.resx</path> <startLine>720</startLine> </read_file>",
    [{ name: "read_file", args: { path: "D:\\x\\S.resx", startLine: 720 } }],
  ],
  [
    "#17 DSML-prefixed invoke with extra attributes",
    `${DSML}tool_calls> ${DSML}invoke name="grep_search"> ${DSML}parameter name="query" string="true">riskCRUD${DSML_CLOSE}parameter> ${DSML}parameter name="isRegexp" string="false">false${DSML_CLOSE}parameter> ${DSML_CLOSE}invoke>`,
    [{ name: "grep_search", args: { query: "riskCRUD", isRegexp: false } }],
  ],
  [
    "#19 DSML with a space before the name and a bare `calls` wrapper",
    `${DSML} calls>\n${DSML} invoke name="read_file">\n${DSML} parameter name="filePath" string="true">src/a.ts${DSML_CLOSE} parameter>\n${DSML_CLOSE} invoke>\n${DSML_CLOSE} calls>`,
    [{ name: "read_file", args: { filePath: "src/a.ts" } }],
  ],
  [
    "#19 two DSML `calls` blocks back to back",
    `${DSML} calls>\n${DSML} invoke name="read_file">\n${DSML} parameter name="filePath">a.ts${DSML_CLOSE} parameter>\n${DSML_CLOSE} invoke>\n${DSML_CLOSE} calls>\n${DSML} calls>\n${DSML} invoke name="grep_search">\n${DSML} parameter name="query">foo${DSML_CLOSE} parameter>\n${DSML_CLOSE} invoke>\n${DSML_CLOSE} calls>`,
    [
      { name: "read_file", args: { filePath: "a.ts" } },
      { name: "grep_search", args: { query: "foo" } },
    ],
  ],
];

describe("tool call dialects", () => {
  for (const [label, text, expected] of DIALECTS) {
    it.each(SIZES)(`${label} — chunk size %d`, (size) => {
      expect(route(text, size).calls).toEqual(expected);
    });
  }

  it("leaves no protocol tags in the visible text", () => {
    const { text } = route(
      'Let me look.\n\n<function_calls>\n<invoke name="list_dir">\n<parameter name="path">.</parameter>\n</invoke>\n</function_calls>\n\nThen I report.',
      3,
    );
    expect(text).toBe("Let me look.\n\nThen I report.");
  });

  it.each(SIZES)("leaves no DSML tags in the visible text (#19) — chunk size %d", (size) => {
    const { text, calls } = route(
      `Let me look.\n\n${DSML} calls>\n${DSML} invoke name="list_dir">\n${DSML} parameter name="path">.${DSML_CLOSE} parameter>\n${DSML_CLOSE} invoke>\n${DSML_CLOSE} calls>`,
      size,
    );
    expect(text.trim()).toBe("Let me look.");
    expect(calls).toEqual([{ name: "list_dir", args: { path: "." } }]);
  });

  it("keeps a bare <calls> in prose", () => {
    const prose = "The XML has <calls> and </calls> elements.";
    expect(route(prose, 3)).toEqual({ text: prose, calls: [] });
  });

  it("does not treat the protocol example from our own prompt as a call", () => {
    const { calls } = route(
      'Format:\n```tool_call\n{"name":"tool_name","arguments":{"param":"value"}}\n```',
      7,
    );
    expect(calls).toEqual([]);
  });
});

// Ordinary answers must come through byte for byte: every false marker hit
// that eats or reorders prose is a visible bug.
const PROSE = [
  "Here is a plan:\n1. read the file\n2. patch it",
  "The model wrongly emits <invoke tags. We should convert them.",
  "Use <div>, <span>, and <function> is not valid HTML.",
  "Используй <тег> для этого элемента, а в C# это List<Строка>.",
  "See <https://пример.рф/путь> and <https://example.com>.",
  "The type is Map<string, Array<number>> in TypeScript.",
  "```xml\n<config>\n  <query>value</query>\n</config>\n```",
  "Render <Button onClick={fn}>Save</Button> inside <Form>.",
  "日本語のテキストと <タグ> の組み合わせ。Emoji 🚀 and <🎯>.",
  'JSON the user asked for: {"name":"my-pkg","version":"1.0.0"}',
  '<!-- invoke name="x" --> and <!-- calls --> are comments (#19).',
  "In R: f <- function(x) x > 1",
];

describe("prose integrity", () => {
  for (const text of PROSE) {
    it.each([1, 2, 5, 11, 1e9])(`${JSON.stringify(text.slice(0, 40))} — chunk size %d`, (size) => {
      const result = route(text, size);
      expect(result.calls).toEqual([]);
      expect(result.text).toBe(text);
    });
  }
});

describe("tools system prompt", () => {
  const prompt = buildToolsSystemPrompt([
    {
      name: "view",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          view_range: { type: "array", items: { type: "integer" } },
        },
      },
    },
    {
      name: "grep_search",
      description: "Search",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          isRegexp: { type: "boolean" },
        },
      },
    },
  ]);

  it("tells the model the JSON type of every non-string argument", () => {
    expect(prompt).toContain('"view_range": "integer[]"');
    expect(prompt).toContain('"isRegexp": "boolean"');
  });

  it("keeps argument names clean (types live apart from them)", () => {
    expect(prompt).not.toMatch(/"view_range:integer/);
    expect(prompt).toContain('"view_range"\n');
  });
});
