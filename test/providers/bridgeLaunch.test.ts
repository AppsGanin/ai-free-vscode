import { describe, expect, it, vi } from "vitest";

// Parallel requests (Copilot, the harness) used to launch the bridge twice:
// the second launch hit the Chrome profile lock and failed both requests.
const launches = vi.hoisted(() => ({ qwen: 0, zai: 0 }));
const fakeContext = () => ({
  addInitScript: async () => undefined,
  exposeBinding: async () => undefined,
  on: () => undefined,
  pages: () => [],
  newPage: async () => ({ on: () => undefined }),
});

vi.mock("../../src/providers/qwen/QwenBrowser", () => ({
  browserDataDir: () => "/tmp/qwen-profile",
  launchQwenContext: async () => {
    launches.qwen++;
    await new Promise((r) => setTimeout(r, 20));
    return fakeContext();
  },
}));
vi.mock("../../src/providers/common/browserAuth", async (original) => ({
  ...(await original<object>()),
  launchPersistentProfile: async () => {
    launches.zai++;
    await new Promise((r) => setTimeout(r, 20));
    return fakeContext();
  },
}));

const { QwenBrowserBridge } = await import("../../src/providers/qwen/QwenBrowserBridge");
const { ZaiBrowserBridge } = await import("../../src/providers/zai/ZaiBrowserBridge");

describe("browser bridge launch", () => {
  it("is shared by concurrent callers", async () => {
    const qwen = new QwenBrowserBridge(() => undefined, "headless") as unknown as {
      ensureContext(): Promise<unknown>;
    };
    const [a, b] = await Promise.all([qwen.ensureContext(), qwen.ensureContext()]);
    expect(a).toBe(b);
    expect(launches.qwen).toBe(1);

    const zai = new ZaiBrowserBridge(() => undefined, "headless") as unknown as {
      ensureContext(): Promise<unknown>;
    };
    await Promise.all([zai.ensureContext(), zai.ensureContext(), zai.ensureContext()]);
    expect(launches.zai).toBe(1);
  });
});
