import { describe, expect, it } from "vitest";
import {
  MAX_WAF_COOLDOWN_MS,
  MIN_REQUEST_INTERVAL_MS,
  WAF_COOLDOWN_MS,
  ZaiRequestGate,
} from "../../src/providers/zai/ZaiRequestGate";

/** A gate on a manual clock: sleeping just moves time forward. */
function gateOnClock() {
  let now = 1_000_000;
  const slept: number[] = [];
  const gate = new ZaiRequestGate(
    () => now,
    async (ms) => {
      slept.push(ms);
      now += ms;
    },
  );
  return { gate, slept, advance: (ms: number) => (now += ms) };
}

describe("Z.ai request gate", () => {
  it("spaces requests out", async () => {
    const { gate, slept, advance } = gateOnClock();
    await gate.beforeRequest();
    advance(1000);
    await gate.beforeRequest();
    expect(slept).toEqual([MIN_REQUEST_INTERVAL_MS - 1000]);
  });

  it("does not wait when the model took longer than the interval anyway", async () => {
    const { gate, slept, advance } = gateOnClock();
    await gate.beforeRequest();
    advance(12_000);
    await gate.beforeRequest();
    expect(slept).toEqual([]);
  });

  it("sends nothing while sitting out a WAF block, then lets requests through", async () => {
    const { gate, advance } = gateOnClock();
    gate.blocked();
    await expect(gate.beforeRequest()).rejects.toThrow(/try again in 5 min/);
    advance(WAF_COOLDOWN_MS - 60_000);
    await expect(gate.beforeRequest()).rejects.toThrow(/try again in 1 min/);
    advance(60_000);
    await expect(gate.beforeRequest()).resolves.toBeUndefined();
  });

  it("doubles the pause when blocked again right after one, up to a cap", () => {
    const { gate, advance } = gateOnClock();
    const pauses: number[] = [];
    for (let i = 0; i < 5; i++) {
      gate.blocked();
      pauses.push(gate.pausedFor);
      advance(gate.pausedFor);
    }
    expect(pauses).toEqual([
      WAF_COOLDOWN_MS,
      WAF_COOLDOWN_MS * 2,
      WAF_COOLDOWN_MS * 4,
      MAX_WAF_COOLDOWN_MS,
      MAX_WAF_COOLDOWN_MS,
    ]);
  });

  it("starts from the short pause again once a request got through", () => {
    const { gate, advance } = gateOnClock();
    gate.blocked();
    advance(gate.pausedFor);
    gate.blocked();
    expect(gate.pausedFor).toBe(WAF_COOLDOWN_MS * 2);
    advance(gate.pausedFor);
    gate.passed();
    advance(60 * 60_000);
    gate.blocked();
    expect(gate.pausedFor).toBe(WAF_COOLDOWN_MS);
  });
});
