import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import { memorySecrets } from "../../test/helpers";
import { FreeAiAdapter, type Route } from "../src/adapter";
import { registerCommands } from "../src/commands";

class FakeProvider extends BaseAIProvider {
  readonly id = "fake";
  readonly displayName = "Qwen (Web)";
  signedIn = false;
  logins = 0;
  release: (() => void) | undefined;
  getModels() {
    return [];
  }
  async isAuthenticated() {
    return this.signedIn;
  }
  async login() {
    this.logins++;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    this.signedIn = true;
  }
  async logout() {
    this.signedIn = false;
  }
  async *sendMessageStream() {}
}

type Handler = (invocation: { rawInput: string; signal: AbortSignal }) => Promise<{ kind: string; text?: string }>;

function setup() {
  const provider = new FakeProvider();
  const route: Route = { key: "qwen", id: "qwen-web", name: provider.displayName, provider };
  const adapter = new FreeAiAdapter([route], memorySecrets(), true);
  let handler!: Handler;
  registerCommands({ commands: { register: (d: { handler: Handler }) => (handler = d.handler) } } as never, adapter, [route]);
  const run = (rawInput: string) => handler({ rawInput, signal: new AbortController().signal });
  return { provider, adapter, route, run };
}

describe("/free-ai", () => {
  it("reports who is signed in", async () => {
    const { run } = setup();
    expect(await run("")).toEqual({ kind: "success", text: "qwen ✗ not signed in" });
  });

  it("signs in and out of a provider", async () => {
    const { provider, run } = setup();
    const login = run("login qwen");
    await Promise.resolve();
    provider.release?.();
    expect(await login).toEqual({ kind: "success", text: "Qwen (Web): signed in." });
    expect((await run("status")).text).toBe("qwen ✓ signed in");
    expect(await run("logout qwen")).toEqual({ kind: "success", text: "Qwen (Web): signed out." });
    expect(provider.signedIn).toBe(false);
  });

  it("shares one sign-in window with a request that needs it", async () => {
    const { provider, adapter, route, run } = setup();
    const fromCommand = run("login qwen");
    const fromRequest = adapter.signIn(route);
    await Promise.resolve();
    provider.release?.();
    await Promise.all([fromCommand, fromRequest]);
    expect(provider.logins).toBe(1);
  });

  it("explains a wrong provider or action", async () => {
    const { run } = setup();
    expect(await run("login gpt")).toMatchObject({ kind: "error", text: expect.stringContaining('Unknown provider "gpt"') });
    expect(await run("dance")).toMatchObject({ kind: "error", text: expect.stringContaining("Usage: /free-ai") });
  });
});
