import { afterEach, describe, expect, it, vi } from "vitest";
import { KimiAuthManager, expiresSoon } from "../../src/providers/kimi/KimiAuthManager";
import { KimiProvider } from "../../src/providers/kimi/KimiProvider";
import { AuthExpiredError } from "../../src/providers/types";
import { collect, memorySecrets } from "../helpers";

const KEY = "ai-free-vscode.kimi.auth";
/** A JWT expiring `minutes` from now (signature irrelevant here). */
const jwt = (minutes: number, tag = "a") =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + minutes * 60, tag })).toString("base64url")}.sig`;

afterEach(() => vi.unstubAllGlobals());

describe("Kimi token refresh", () => {
  it("tells a token that is about to expire", () => {
    expect(expiresSoon(jwt(0.5))).toBe(true);
    expect(expiresSoon(jwt(10))).toBe(false);
  });

  it("trades the refresh token on Kimi's auth host and stores the new pair", async () => {
    const old = { token: jwt(0), origin: "https://www.kimi.ai", refreshToken: jwt(1000, "r1") };
    const secrets = memorySecrets({ [KEY]: JSON.stringify(old) });
    const fresh = { accessToken: jwt(15, "a2"), refreshToken: jwt(1000, "r2") };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fresh), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const manager = new KimiAuthManager();
    // Two requests at once share one trade.
    const [a, b] = await Promise.all([manager.refresh(secrets as never, old), manager.refresh(secrets as never, old)]);
    expect(a).toEqual({ token: fresh.accessToken, origin: old.origin, refreshToken: fresh.refreshToken });
    expect(b).toEqual(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://auth.kimi.ai/api/account.gateway.v1.AuthService/RefreshToken",
    );
    expect(await manager.getAuth(secrets as never)).toEqual(a);
  });

  it("has nothing to trade for a sign-in stored before refreshing existed", async () => {
    const secrets = memorySecrets({ [KEY]: JSON.stringify({ token: jwt(0), origin: "https://www.kimi.ai" }) });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = new KimiAuthManager();
    expect(await manager.refresh(secrets as never, (await manager.getAuth(secrets as never))!)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Kimi provider on an expired token", () => {
  const provider = (stream: (token: string) => AsyncIterable<never>) => {
    const p = new KimiProvider();
    const seen: string[] = [];
    Object.assign(p, {
      apiClient: {
        sendMessageStream: (_params: unknown, auth: { token: string }) => {
          seen.push(auth.token);
          return stream(auth.token);
        },
      },
    });
    return { p, seen };
  };
  const ask = (p: KimiProvider, secrets: unknown) =>
    collect(p.sendMessageStream({ model: "kimi-instant", messages: [{ role: "user", content: "hi" }] }, secrets as never));

  it("refreshes and retries once instead of signing the user out", async () => {
    const stale = jwt(10, "stale");
    const secrets = memorySecrets({ [KEY]: JSON.stringify({ token: stale, origin: "https://www.kimi.ai", refreshToken: jwt(1000, "r") }) });
    const renewed = jwt(15, "renewed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: renewed, refreshToken: jwt(1000, "r2") }))));
    const { p, seen } = provider(async function* (token) {
      if (token === stale) throw new AuthExpiredError("ai-free-vscode-kimi", 401);
      yield { type: "text", content: "ok" } as never;
    });
    expect((await ask(p, secrets)).text).toBe("ok");
    expect(seen).toEqual([stale, renewed]);
    expect(await p.isAuthenticated(secrets as never)).toBe(true);
  });

  it("signs out when there is nothing to refresh with", async () => {
    const secrets = memorySecrets({ [KEY]: JSON.stringify({ token: jwt(10), origin: "https://www.kimi.ai" }) });
    const { p } = provider(async function* () {
      throw new AuthExpiredError("ai-free-vscode-kimi", 401);
    });
    await expect(ask(p, secrets)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(await p.isAuthenticated(secrets as never)).toBe(false);
  });

  it("renews a token that is about to expire before sending", async () => {
    const secrets = memorySecrets({ [KEY]: JSON.stringify({ token: jwt(0.2, "old"), origin: "https://www.kimi.com", refreshToken: jwt(1000) }) });
    const renewed = jwt(15, "new");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accessToken: renewed, refreshToken: jwt(1000) })));
    vi.stubGlobal("fetch", fetchMock);
    const { p, seen } = provider(async function* () {
      yield { type: "text", content: "ok" } as never;
    });
    await ask(p, secrets);
    expect(seen).toEqual([renewed]);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("https://auth.kimi.com/");
  });
});
