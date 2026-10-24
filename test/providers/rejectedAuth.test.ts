import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import { forgetRejected } from "../../src/providers/common/rejectedAuth";
import { KimiAuthManager } from "../../src/providers/kimi/KimiAuthManager";
import { QwenAuthManager } from "../../src/providers/qwen/QwenAuthManager";
import { QwenProvider } from "../../src/providers/qwen/QwenProvider";
import type { AIModelInfo } from "../../src/providers/types";
import { AuthExpiredError } from "../../src/providers/types";
import { UnifiedProvider } from "../../src/providers/UnifiedProvider";
import { ZaiAuthManager } from "../../src/providers/zai/ZaiAuthManager";
import { collect, memorySecrets } from "../helpers";

const OLD = "eyJold.payload.sig";
const NEW = "eyJnew.payload.sig";

describe("forgetting a refused sign-in", () => {
  it("deletes only while the refused credential is still stored", async () => {
    const secrets = memorySecrets({ k: OLD });
    expect(await forgetRejected(secrets as never, "k", (v) => v === NEW)).toBe(false);
    expect(await secrets.get("k")).toBe(OLD);
    expect(await forgetRejected(secrets as never, "k", (v) => v === OLD)).toBe(true);
    expect(await secrets.get("k")).toBeUndefined();
  });

  it("keeps a sign-in that replaced the refused one", async () => {
    const secrets = memorySecrets({ "ai-free-vscode.qwen.token": NEW });
    await new QwenAuthManager().forget(secrets as never, OLD);
    expect(await secrets.get("ai-free-vscode.qwen.token")).toBe(NEW);
  });

  it("matches the token the way getAuth reads it", async () => {
    // Stored with a Bearer prefix; getAuth hands out the bare JWT.
    const kimi = memorySecrets({
      "ai-free-vscode.kimi.auth": JSON.stringify({ token: `Bearer ${OLD}`, origin: "https://www.kimi.com" }),
    });
    const kimiAuth = await new KimiAuthManager().getAuth(kimi as never);
    await new KimiAuthManager().forget(kimi as never, kimiAuth!.token);
    expect(await kimi.get("ai-free-vscode.kimi.auth")).toBeUndefined();

    const zai = memorySecrets({ "ai-free-vscode.zai.auth": JSON.stringify({ token: OLD }) });
    await new ZaiAuthManager().forget(zai as never, OLD);
    expect(await zai.get("ai-free-vscode.zai.auth")).toBeUndefined();
  });
});

describe("Qwen on a refused token", () => {
  const qwen = (createChat: () => Promise<string>) => {
    const secrets = memorySecrets({ "ai-free-vscode.qwen.token": OLD });
    const p = new QwenProvider();
    // The live browser has nothing newer to offer.
    Object.assign(p, {
      browser: { readToken: async () => OLD, close: async () => undefined },
      apiClient: { createChat },
    });
    return { p, secrets };
  };
  const ask = (p: QwenProvider, secrets: unknown) =>
    collect(p.sendMessageStream({ model: "qwen3.8-max", messages: [{ role: "user", content: "hi" }] }, secrets as never));

  it("forgets it once the browser session cannot replace it", async () => {
    const { p, secrets } = qwen(async () => {
      throw new AuthExpiredError("ai-free-vscode-qwen", 401);
    });
    let changed = 0;
    p.onDidAuthChange(() => changed++);
    await expect(ask(p, secrets)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(await secrets.get("ai-free-vscode.qwen.token")).toBeUndefined();
    expect(await p.isAuthenticated(secrets as never)).toBe(false);
    expect(changed).toBe(1);
  });

  it("keeps it on a bare 403", async () => {
    const { p, secrets } = qwen(async () => {
      throw new AuthExpiredError("ai-free-vscode-qwen", 403);
    });
    await expect(ask(p, secrets)).rejects.toBeInstanceOf(AuthExpiredError);
    expect(await secrets.get("ai-free-vscode.qwen.token")).toBe(OLD);
  });
});

describe("Sign In", () => {
  const model: AIModelInfo = { id: "m", name: "M", family: "F", maxInputTokens: 1, maxOutputTokens: 1, capabilities: {} };
  class Stub extends BaseAIProvider {
    readonly id = "stub";
    readonly displayName = "Stub";
    signedIn = false;
    constructor(private readonly saves: boolean) {
      super();
    }
    getModels() {
      return [model];
    }
    async isAuthenticated() {
      return this.signedIn;
    }
    async login() {
      this.signedIn = this.saves;
    }
    async logout() {
      this.signedIn = false;
    }
    async *sendMessageStream() {}
  }

  it("reports success only once the session reads back", async () => {
    expect(await new UnifiedProvider([new Stub(true)]).signIn(memorySecrets() as never, "stub")).toBe(true);
    await expect(new UnifiedProvider([new Stub(false)]).signIn(memorySecrets() as never, "stub")).rejects.toThrow(
      /not saved/,
    );
  });

  it("is not a success when the provider picker is dismissed", async () => {
    // The test window's showQuickPick resolves undefined, as on Esc.
    expect(await new UnifiedProvider([new Stub(true)]).signIn(memorySecrets() as never)).toBe(false);
  });
});
