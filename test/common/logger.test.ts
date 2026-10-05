import { afterEach, describe, expect, it } from "vitest";
import {
  createLogger,
  errDetails,
  recentLog,
  redact,
  setOutputChannel,
  withRequestId,
} from "../../src/logger";
import { ProviderError } from "../../src/providers/types";
import { setSetting } from "../mocks/vscode";

function captureChannel(): string[] {
  const lines: string[] = [];
  setOutputChannel({ appendLine: (line: string) => lines.push(line) } as never);
  return lines;
}

afterEach(() => setSetting("freeAI.debug", undefined));

describe("log redaction", () => {
  it.each([
    ["Authorization: Bearer abc.def-123", "Bearer ***"],
    ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig_part", "eyJ***"],
    ["key sk-1234567890abcdef", "sk-***"],
    ["proxy http://alice:s3cret@10.0.0.1:8080", "http://***:***@10.0.0.1:8080"],
    ["cookie: token=abc; ds_session_id=xyz", "cookie: ***"],
    ["url /api?access_token=abc123&x=1", "access_token=***&x=1"],
    ['body {"refresh_token":"abc","name":"x"}', '"refresh_token":"***"'],
    ["signed in as john.doe+ai@gmail.com", "***@***"],
  ])("masks %s", (input, expected) => {
    const out = redact(input);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/abc123|s3cret|1234567890abcdef|john\.doe|eyJzdWIi|abc\.def/);
  });

  it.each([
    "sessionKind=new chatId=1f2e",
    "inside=1 outside=2",
    "playwright@1.50.0",
    "provider usage prompt=120 completion=40 max_tokens=500",
    "tool_call #1 read_file {\"filePath\":\"/a/b.ts\",\"startLine\":1}",
  ])("leaves %s readable", (input) => {
    expect(redact(input)).toBe(input);
  });
});

describe("logger", () => {
  it("writes DEBUG only with freeAI.debug on", () => {
    const lines = captureChannel();
    const log = createLogger("t");
    log.debug("hidden");
    setSetting("freeAI.debug", true);
    log.debug("shown");
    expect(lines.join("\n")).not.toContain("hidden");
    expect(lines.join("\n")).toMatch(/\[DEBUG\] \[t\] shown/);
  });

  it("tags every line of a request with its id, across awaits", async () => {
    const lines = captureChannel();
    const log = createLogger("t");
    await Promise.all([
      withRequestId("aaaa", async () => {
        log.info("one");
        await new Promise((r) => setTimeout(r, 5));
        log.info("three");
      }),
      withRequestId("bbbb", async () => {
        await new Promise((r) => setTimeout(r, 1));
        log.info("two");
      }),
    ]);
    log.info("outside");
    expect(lines.filter((l) => l.includes("[#aaaa]")).map((l) => l.split(" ").pop())).toEqual([
      "one",
      "three",
    ]);
    expect(lines.find((l) => l.endsWith("two"))).toContain("[#bbbb]");
    expect(lines.find((l) => l.endsWith("outside"))).not.toContain("[#");
  });

  it("keeps recent lines for the report, already redacted", () => {
    captureChannel();
    createLogger("t").info("token=abc123 sent");
    const last = recentLog().pop();
    expect(last).toContain("token=***");
    expect(last).not.toContain("abc123");
  });

  it("caps the recent buffer", () => {
    captureChannel();
    const log = createLogger("t");
    for (let i = 0; i < 2000; i++) log.info(`line ${i}`);
    const recent = recentLog();
    expect(recent.length).toBe(1500);
    expect(recent.pop()).toContain("line 1999");
  });

  it("describes provider errors with class, provider, status and stack", () => {
    const text = errDetails(new ProviderError("ai-free-vscode-qwen", "HTTP 502: bad gateway", 502));
    expect(text).toMatch(/^ProviderError provider=ai-free-vscode-qwen status=502: HTTP 502/);
    expect(text).toContain("| at ");
  });
});
