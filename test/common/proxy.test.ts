import { afterEach, describe, expect, it } from "vitest";
import { browserProxy } from "../../src/providers/common/browserAuth";
import { setSetting } from "../mocks/vscode";

afterEach(() => {
  setSetting("freeAI.proxy", undefined);
  setSetting("http.proxy", undefined);
  setSetting("http.noProxy", undefined);
});

describe("browser proxy", () => {
  it("is off when nothing is configured", () => {
    expect(browserProxy()).toBeUndefined();
  });

  it("follows VS Code's http.proxy, so one setting covers Node and the browsers", () => {
    setSetting("http.proxy", "http://proxy.corp:3128");
    expect(browserProxy()).toEqual({ server: "http://proxy.corp:3128" });
  });

  it("prefers freeAI.proxy over http.proxy", () => {
    setSetting("http.proxy", "http://proxy.corp:3128");
    setSetting("freeAI.proxy", "socks5://127.0.0.1:1080");
    expect(browserProxy()).toEqual({ server: "socks5://127.0.0.1:1080" });
  });

  it("passes credentials separately, decoded", () => {
    setSetting("freeAI.proxy", "http://us%40er:p%3Ass@10.0.0.2:8080");
    expect(browserProxy()).toEqual({
      server: "http://10.0.0.2:8080",
      username: "us@er",
      password: "p:ss",
    });
  });

  it("accepts a bare host:port", () => {
    setSetting("freeAI.proxy", "10.0.0.2:8080");
    expect(browserProxy()?.server).toBe("http://10.0.0.2:8080");
  });

  it("bypasses the hosts from http.noProxy", () => {
    setSetting("freeAI.proxy", "http://p:1");
    setSetting("http.noProxy", ["localhost", " *.corp "]);
    expect(browserProxy()?.bypass).toBe("localhost,*.corp");
  });

  it("goes direct instead of failing on a malformed value", () => {
    setSetting("freeAI.proxy", "http://exa mple:80");
    expect(browserProxy()).toBeUndefined();
  });
});

describe("proxy check helpers", () => {
  it("parses what the field accepts", async () => {
    const { parseProxy } = await import("../../src/providers/common/browserAuth");
    expect(parseProxy("socks5://1.2.3.4:1080")).toEqual({ server: "socks5://1.2.3.4:1080" });
    expect(parseProxy(" 1.2.3.4:3128 ")).toEqual({ server: "http://1.2.3.4:3128" });
    expect(parseProxy("not a proxy")).toBeUndefined();
  });

  it.each([
    ["net::ERR_TUNNEL_CONNECTION_FAILED at https://api.ipify.org/", /refused to connect.*needs a login/],
    ["net::ERR_PROXY_CONNECTION_FAILED at https://api.ipify.org/", /Cannot reach the proxy/],
    ["net::ERR_SOCKS_CONNECTION_FAILED", /SOCKS handshake failed/],
    ["page.goto: Timeout 20000ms exceeded.", /No answer within 20 s/],
  ])("explains %s", async (raw, reason) => {
    const { describeProxyFailure } = await import("../../src/providers/common/browserAuth");
    expect(describeProxyFailure(raw)).toMatch(reason);
  });
});
