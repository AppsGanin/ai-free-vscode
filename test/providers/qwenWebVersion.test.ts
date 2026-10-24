import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseWebVersion,
  refreshWebVersion,
  resetWebVersion,
  webVersion,
} from "../../src/providers/qwen/QwenWebVersion";

const home = (version: string) =>
  new Response(
    `<link rel="icon" href="//assets.alicdn.com/g/qwenweb/qwen-chat-fe/${version}/favicon.png">`,
  );

afterEach(() => {
  resetWebVersion();
  vi.unstubAllGlobals();
});

describe("Qwen web version", () => {
  it("reads the version from the asset paths", () => {
    expect(
      parseWebVersion('<script src="//assets.alicdn.com/g/qwenweb/qwen-chat-fe/0.3.22/js/main.js">'),
    ).toBe("0.3.22");
    expect(parseWebVersion("<html></html>")).toBeUndefined();
  });

  it("caches the home page and re-reads it when forced", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(home("1.0.0")).mockResolvedValueOnce(home("1.0.1"));
    vi.stubGlobal("fetch", fetchMock);
    expect(await refreshWebVersion()).toBe("1.0.0");
    expect(await refreshWebVersion()).toBe("1.0.0");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await refreshWebVersion(true)).toBe("1.0.1");
    expect(webVersion()).toBe("1.0.1");
  });

  it("keeps the previous version when the page cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const before = webVersion();
    expect(await refreshWebVersion()).toBe(before);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>challenge</html>")));
    expect(await refreshWebVersion(true)).toBe(before);
  });

  it("shares one request between concurrent callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(home("2.0.0"));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([refreshWebVersion(), refreshWebVersion(true), refreshWebVersion(true)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
