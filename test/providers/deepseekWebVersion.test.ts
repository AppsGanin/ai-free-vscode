import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appVersion,
  parseAppVersion,
  parseMainBundle,
  refreshAppVersion,
  resetAppVersion,
} from "../../src/providers/deepseek/DeepSeekWebVersion";

afterEach(() => {
  resetAppVersion();
  vi.unstubAllGlobals();
});

describe("DeepSeek web version", () => {
  it("finds the bundle and the version in it", () => {
    expect(
      parseMainBundle('<script src="https://fe-static.deepseek.com/chat/static/main.d1d163b7e4.js">'),
    ).toBe("static/main.d1d163b7e4.js");
    expect(parseAppVersion('r={nodeEnv:"production",dev:!1,appVersion:"2.7.0",commitId:"1"}')).toBe("2.7.0");
  });

  it("reads home page then bundle, with the session cookies, once per interval", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith(".js")
        ? new Response('appVersion:"3.1.4"')
        : new Response('<script src="//fe-static.deepseek.com/chat/static/main.abc123.js">'),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshAppVersion("ds_session_id=1")).toBe("3.1.4");
    expect(await refreshAppVersion("ds_session_id=1")).toBe("3.1.4");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://chat.deepseek.com/",
      "https://fe-static.deepseek.com/chat/static/main.abc123.js",
    ]);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Cookie: "ds_session_id=1" });
    expect(appVersion()).toBe("3.1.4");
  });

  it("keeps the previous version behind the WAF", async () => {
    const before = appVersion();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 202 })));
    expect(await refreshAppVersion("")).toBe(before);
  });
});
