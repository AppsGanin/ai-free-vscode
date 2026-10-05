import { describe, expect, it } from "vitest";
import {
  LANGUAGE_GUARD,
  buildFlatTranscript,
  buildRolePrompt,
  conversationKey,
  estimateTokens,
} from "../../src/providers/common/messages";
import type { AIMessage } from "../../src/providers/types";

const user = (content: string): AIMessage => ({ role: "user", content });
const assistant = (content: string): AIMessage => ({ role: "assistant", content });
const system = (content: string): AIMessage => ({ role: "system", content });

describe("buildRolePrompt (Qwen, DeepSeek)", () => {
  it("lays turns out as Role: text and leaves the assistant turn open", () => {
    const prompt = buildRolePrompt([user("Hi"), assistant("Hello"), user("Bye")], {
      system: "Be brief.",
    });
    expect(prompt).toBe("System: Be brief.\n\nUser: Hi\n\nAssistant: Hello\n\nUser: Bye\n\nAssistant:");
  });

  it("drops the oldest turns first and never the latest one", () => {
    const turns = Array.from({ length: 50 }, (_, i) => user(`message ${i} ${"x".repeat(200)}`));
    const prompt = buildRolePrompt(turns, { maxChars: 2_000 });
    expect(prompt.length).toBeLessThanOrEqual(2_000 + "\n\nAssistant:".length);
    expect(prompt).toContain("message 49");
    expect(prompt).not.toContain("message 0 ");
  });

  it("truncates a single huge turn instead of dropping it", () => {
    const prompt = buildRolePrompt([user("start " + "y".repeat(10_000) + " end")], {
      maxChars: 1_000,
    });
    expect(prompt).toContain(" end");
    expect(prompt.length).toBeLessThan(1_200);
  });
});

describe("buildFlatTranscript (Kimi, Z.ai)", () => {
  it("puts the language guard and system text first, the tools protocol last", () => {
    const text = buildFlatTranscript(
      [system("You are helpful."), user("Hi")],
      "TOOLS PROTOCOL",
    );
    expect(text.startsWith(`system:${LANGUAGE_GUARD}\nYou are helpful.`)).toBe(true);
    expect(text).toContain("user:Hi");
    expect(text.endsWith("TOOLS PROTOCOL")).toBe(true);
  });

  it("never trims the system line or the tools protocol to fit", () => {
    const turns = Array.from({ length: 40 }, (_, i) => user(`turn ${i} ${"z".repeat(500)}`));
    const text = buildFlatTranscript([system("KEEP ME"), ...turns], "PROTOCOL", {
      maxChars: 3_000,
    });
    expect(text).toContain("KEEP ME");
    expect(text.endsWith("PROTOCOL")).toBe(true);
    expect(text).toContain("turn 39");
    expect(text).not.toContain("turn 0 ");
  });
});

describe("token estimate", () => {
  it("counts Cyrillic as dearer than Latin", () => {
    const latin = estimateTokens("a".repeat(400));
    const cyrillic = estimateTokens("я".repeat(400));
    expect(cyrillic).toBeGreaterThan(latin * 2);
  });
});

describe("conversation key", () => {
  it("is stable for the same opening message and model", () => {
    const a = conversationKey({ model: "m", messages: [user("Q"), assistant("A")] } as never);
    const b = conversationKey({ model: "m", messages: [user("Q"), assistant("A"), user("next")] } as never);
    expect(a).toBe(b);
  });

  it("differs between models", () => {
    expect(conversationKey({ model: "m1", messages: [user("Q")] } as never)).not.toBe(
      conversationKey({ model: "m2", messages: [user("Q")] } as never),
    );
  });
});
