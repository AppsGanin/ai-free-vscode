import { describe, expect, it } from "vitest";
import {
  AnswerMirror,
  ZaiApiClient,
} from "../../src/providers/zai/ZaiApiClient";
import type {
  ZaiBrowserBridge,
  ZaiBrowserRequest,
} from "../../src/providers/zai/ZaiBrowserBridge";
import { upstreamZaiModelId } from "../../src/providers/zai/ZaiModels";
import {
  AuthExpiredError,
  ProviderError,
  RateLimitError,
} from "../../src/providers/types";
import { collect, sse } from "../helpers";

/**
 * Stands in for the browser bridge: hands back a canned SSE body in small
 * pieces and records the request the client built.
 */
function fakeBridge(body: string, size = 9) {
  const requests: ZaiBrowserRequest[] = [];
  const bridge = {
    async *streamChat(req: ZaiBrowserRequest) {
      requests.push(req);
      for (let i = 0; i < body.length; i += size) yield body.slice(i, i + size);
    },
  } as unknown as ZaiBrowserBridge;
  return { bridge, requests };
}

const rec = (data: Record<string, unknown>) => ({ type: "chat:completion", data });

function send(body: string, params: Record<string, unknown> = {}) {
  const { bridge, requests } = fakeBridge(body);
  const result = collect(
    new ZaiApiClient(bridge).sendMessageStream({
      model: "glm-5.3",
      messages: [{ role: "user", content: "hi" }],
      ...params,
    } as never),
  );
  return { result, requests };
}

describe("Z.ai client", () => {
  it("splits reasoning and answer by phase, with usage mid-answer", async () => {
    // The order chat.z.ai uses: thinking, answer, usage ("other"), the rest.
    const { result } = send(
      sse(
        rec({ phase: "thinking", delta_content: "Let me " }),
        rec({ phase: "thinking", delta_content: "think." }),
        rec({ phase: "answer", delta_content: "Ответ начинается" }),
        rec({ phase: "other", usage: { prompt_tokens: 37, completion_tokens: 9 } }),
        rec({ phase: "answer", delta_content: " здесь." }),
        rec({ phase: "done", done: true }),
      ),
    );
    const out = await result;
    expect(out.thinking).toBe("Let me think.");
    expect(out.text).toBe("Ответ начинается здесь.");
    expect(out.usage).toEqual({ promptTokens: 37, completionTokens: 9 });
  });

  it("asks the bridge for the upstream model id and thinking mode", async () => {
    const { result, requests } = send(sse(rec({ phase: "done", done: true })), {
      model: "glm-5.3-flash",
      thinkingMode: "on",
    });
    await result;
    expect(requests[0].model).toBe(upstreamZaiModelId("glm-5.3-flash"));
    expect(requests[0].thinking).toBe(true);
    expect(requests[0].prompt).toContain("hi");
  });

  it("turns off thinking when tools are in play", async () => {
    const { result, requests } = send(sse(rec({ phase: "done", done: true })), {
      tools: [{ name: "view", description: "", parameters: { type: "object", properties: {} } }],
      thinkingMode: "on",
    });
    await result;
    expect(requests[0].thinking).toBe(false);
  });

  it("turns the text tool protocol into a tool call", async () => {
    const { result } = send(
      sse(
        rec({ phase: "answer", delta_content: "```tool_call\n" }),
        rec({
          phase: "answer",
          delta_content: '{"name":"view","arguments":{"path":"a.ts","view_range":[1,50]}}\n```',
        }),
      ),
      {
        tools: [{ name: "view", description: "", parameters: { type: "object", properties: {} } }],
        toolMode: "auto",
      },
    );
    expect((await result).calls).toEqual([
      { name: "view", args: { path: "a.ts", view_range: [1, 50] } },
    ]);
  });

  it.each([
    ["level", { detail: "Model not available for current user level", code: 403 }, ProviderError, /current user level/],
    ["capacity", { detail: "Model is currently at capacity." }, ProviderError, /at capacity/],
    ["captcha", { error_code: "FRONTEND_CAPTCHA_REQUIRED", detail: "refresh" }, ProviderError, /verification/],
    ["401", { code: 401, detail: "Unauthorized" }, AuthExpiredError, /Authentication expired/],
    ["429", { code: 429, detail: "Too many requests" }, RateLimitError, /Rate limit/],
  ])("maps the %s error record", async (_label, error, type, message) => {
    // A 403 for "not your level" must not read as a lost session: that would
    // sign the user out of a working account.
    const { result } = send(sse(rec({ error, done: true })));
    const failure = await result.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(type);
    expect(String((failure as Error).message)).toMatch(message);
  });

  it("reads errors nested one level deeper too", async () => {
    const { result } = send(
      sse(rec({ data: { error: { error_code: "FRONTEND_CAPTCHA_REQUIRED" } } })),
    );
    await expect(result).rejects.toThrow(/verification/);
  });
});

describe("AnswerMirror (how chat.z.ai assembles a reply)", () => {
  type Record_ = Parameters<AnswerMirror["apply"]>[0];
  function replay(records: Record_[]) {
    const mirror = new AnswerMirror();
    let thinking = "";
    let answer = "";
    for (const r of records) {
      const out = mirror.apply(r);
      thinking += out.thinking ?? "";
      answer += out.answer ?? "";
    }
    return { thinking, answer };
  }

  it("appends deltas", () => {
    expect(
      replay([
        { phase: "thinking", delta_content: "T" },
        { phase: "answer", delta_content: "Hello" },
        { phase: "answer", delta_content: " world" },
      ]),
    ).toEqual({ thinking: "T", answer: "Hello world" });
  });

  it("keeps an answer start that arrives inside edit_content", () => {
    const t = "Let me think about it.";
    expect(
      replay([
        { phase: "thinking", delta_content: t },
        { phase: "answer", edit_index: t.length, edit_content: "\n\n## Поддерживаем" },
        { phase: "answer", delta_content: "ые модели" },
      ]).answer,
    ).toBe("## Поддерживаемые модели");
  });

  it("finds the answer after a <details> reasoning block an edit rewrote", () => {
    expect(
      replay([
        { phase: "thinking", delta_content: '<details type="reasoning">\n> Let me think' },
        {
          phase: "answer",
          edit_index: 39,
          edit_content: "\n> Let me think more.\n</details>\n**Проект** — расширение",
        },
        { phase: "answer", delta_content: " для VS Code." },
      ]).answer,
    ).toBe("**Проект** — расширение для VS Code.");
  });

  it("follows a full content replacement", () => {
    expect(
      replay([
        { phase: "answer", delta_content: "Hello wor" },
        { phase: "answer", content: "Hello world, and more" },
        { phase: "answer", delta_content: "!" },
      ]).answer,
    ).toBe("Hello world, and more!");
  });
});

describe("Z.ai HTTP errors from the browser bridge", () => {
  it("explains the Alibaba WAF block page instead of dumping its HTML", async () => {
    const { httpError, WAF_BLOCKED_MESSAGE } = await import("../../src/providers/zai/ZaiBrowserBridge");
    // Recorded from chat.z.ai after a burst of agent requests.
    const page =
      '<!doctypehtml><html lang="zh-cn"><meta charset="utf-8"><meta http-equiv="X-UA-Compatible"content="IE=edge,chrome=1"><meta name="data-spm"content="a3c0e"><title>405</title><style>a,body{margin:0}</style>';
    const error = httpError(405, page);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toBe(WAF_BLOCKED_MESSAGE);
    expect(error.message).not.toContain("<html");
  });

  it("keeps other HTTP errors as they are", async () => {
    const { httpError } = await import("../../src/providers/zai/ZaiBrowserBridge");
    expect(httpError(500, "Internal Server Error").message).toBe("Z.ai HTTP 500: Internal Server Error");
    expect(httpError(401, "")).toBeInstanceOf(AuthExpiredError);
    expect(httpError(429, "")).toBeInstanceOf(RateLimitError);
  });
});
