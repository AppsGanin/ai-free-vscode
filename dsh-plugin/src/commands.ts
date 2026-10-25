import type { Context } from "@deepseek-ai/cordis";
import type { FreeAiAdapter, Route } from "./adapter";

/**
 * The slice of `@deepseek-ai/dsh-commands` this plugin uses. Declared here so
 * the package does not pull the whole commands domain in for two types.
 */
interface CommandInvocation {
  readonly rawInput: string;
  readonly signal: AbortSignal;
}
type CommandResult = { readonly kind: "success"; readonly text?: string } | { readonly kind: "error"; readonly text: string };
interface CommandsService {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string };
    handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
  }): unknown;
}

const USAGE = "Usage: /free-ai status · /free-ai login <provider> · /free-ai logout <provider>";

/**
 * `/free-ai` in the chat input: who is signed in, and signing in or out of a
 * provider without waiting for a request to need it. Sign-in opens the
 * provider's page in Chrome on the machine the harness runs on.
 */
export function registerCommands(ctx: Context, adapter: FreeAiAdapter, routes: readonly Route[]): void {
  const commands = (ctx as unknown as { commands: CommandsService }).commands;
  const keys = routes.map((route) => route.key).join(", ");

  commands.register({
    name: "free-ai",
    description: "Sign in to or out of the Qwen, DeepSeek, Kimi and Z.ai web providers",
    input: { hint: `status | login <${keys}> | logout <${keys}>` },
    handler: async ({ rawInput }) => {
      const [action = "status", key] = rawInput.trim().toLowerCase().split(/\s+/).filter(Boolean);

      if (action === "status") {
        // One line: the chat renders a command result without its line breaks.
        const states = await Promise.all(
          routes.map(async (route) => `${route.key} ${(await adapter.isSignedIn(route)) ? "✓ signed in" : "✗ not signed in"}`),
        );
        return { kind: "success", text: states.join(" · ") };
      }

      if (action !== "login" && action !== "logout") return { kind: "error", text: USAGE };
      const route = routes.find((r) => r.key === key || r.id === key);
      if (!route) return { kind: "error", text: `Unknown provider "${key ?? ""}". One of: ${keys}.\n${USAGE}` };

      if (action === "logout") {
        await adapter.signOut(route);
        return { kind: "success", text: `${route.name}: signed out.` };
      }
      try {
        await adapter.signIn(route);
        return { kind: "success", text: `${route.name}: signed in.` };
      } catch (err) {
        return { kind: "error", text: `${route.name}: sign-in failed — ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  });
}
