import { describe, expect, it } from "vitest";
import { BaseAIProvider } from "../../src/providers/BaseAIProvider";
import type { AIModelInfo, AIRequestParams } from "../../src/providers/types";
import { UnifiedProvider } from "../../src/providers/UnifiedProvider";
import { collect } from "../helpers";

const model = (id: string, family = "F"): AIModelInfo => ({
  id,
  name: id.toUpperCase(),
  family,
  maxInputTokens: 1000,
  maxOutputTokens: 100,
  capabilities: { toolCalling: true },
});

class Stub extends BaseAIProvider {
  readonly id: string;
  readonly displayName: string;
  constructor(
    name: string,
    private readonly models: AIModelInfo[],
    public signedIn = true,
  ) {
    super();
    this.id = `stub-${name}`;
    this.displayName = `${name} (Web)`;
  }
  getModels() {
    return this.models;
  }
  async isAuthenticated() {
    return this.signedIn;
  }
  async login() {
    this.signedIn = true;
  }
  async logout() {
    this.signedIn = false;
  }
  async *sendMessageStream(params: AIRequestParams) {
    yield { type: "text" as const, content: `${this.id}:${params.model}` };
  }
}

const secrets = {} as never;

describe("UnifiedProvider", () => {
  it("sends each model to the provider that owns it", async () => {
    const unified = new UnifiedProvider([
      new Stub("Alpha", [model("a1")]),
      new Stub("Beta", [model("b1")]),
    ]);
    const out = await collect(
      unified.sendMessageStream({ model: "b1", messages: [] } as never, secrets),
    );
    expect(out.text).toBe("stub-Beta:b1");
  });

  it("offers only models of providers the user is signed into", async () => {
    const unified = new UnifiedProvider([
      new Stub("Alpha", [model("a1")], true),
      new Stub("Beta", [model("b1")], false),
    ]);
    const ids = (await unified.getAvailableModels(secrets)).map((m) => m.id);
    expect(ids).toEqual(["a1"]);
  });

  it("prefixes the family with the provider, which groups the picker", () => {
    const unified = new UnifiedProvider([new Stub("Alpha", [model("a1", "GLM")])]);
    expect(unified.getModels()[0].family).toBe("Alpha/GLM");
  });

  it("keeps the first owner of a colliding model id", async () => {
    const unified = new UnifiedProvider([
      new Stub("Alpha", [model("same")]),
      new Stub("Beta", [model("same")]),
    ]);
    expect(unified.getModels()).toHaveLength(1);
    const out = await collect(
      unified.sendMessageStream({ model: "same", messages: [] } as never, secrets),
    );
    expect(out.text).toBe("stub-Alpha:same");
  });

  it("rejects a model nobody registered", () => {
    const unified = new UnifiedProvider([new Stub("Alpha", [model("a1")])]);
    expect(() =>
      unified.sendMessageStream({ model: "ghost", messages: [] } as never, secrets),
    ).toThrow(/not registered/);
  });

  it("reports per-provider sign-in state", async () => {
    const unified = new UnifiedProvider([
      new Stub("Alpha", [model("a1")], true),
      new Stub("Beta", [model("b1")], false),
    ]);
    expect(
      (await unified.getProviderAuthStates(secrets)).map((s) => [s.name, s.authenticated]),
    ).toEqual([
      ["Alpha", true],
      ["Beta", false],
    ]);
  });
});
