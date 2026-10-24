import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { DeepSeekProvider } from "../../src/providers/deepseek/DeepSeekProvider";
import { KimiProvider } from "../../src/providers/kimi/KimiProvider";
import { QwenProvider } from "../../src/providers/qwen/QwenProvider";
import { ZaiProvider } from "../../src/providers/zai/ZaiProvider";
import { FreeAiAdapter, type Route } from "./adapter";
import { FileSecretStore, installHost } from "./host";

export const name = "free-ai";
export const inject = ["llm"];

type RouteKey = "qwen" | "deepseek" | "kimi" | "zai";

export interface Config {
  providers: RouteKey[];
  autoSignIn: boolean;
  browserMode: "auto" | "headed" | "headless";
  loginTimeoutMs: number;
  proxy: string;
  debug: boolean;
}

export const Config: Schema<Config> = Schema.object({
  providers: Schema.array(Schema.union(["qwen", "deepseek", "kimi", "zai"]))
    .default(["qwen", "deepseek", "kimi", "zai"])
    .description("Web backends to offer as model providers."),
  autoSignIn: Schema.boolean()
    .default(true)
    .description("Open the provider's sign-in window on the first request without a session."),
  browserMode: Schema.union(["auto", "headed", "headless"])
    .default("auto")
    .description("How the Qwen and Z.ai browser bridges show their window."),
  loginTimeoutMs: Schema.natural().default(300000).description("How long a sign-in window waits."),
  proxy: Schema.string().default("").description("Proxy for the browser windows, e.g. http://host:3128."),
  debug: Schema.boolean().default(false).description("Write DEBUG lines to ~/.ai-free-vscode/dsh/free-ai.log."),
});

const BACKENDS: Record<RouteKey, { id: string; create: () => Route["provider"] }> = {
  qwen: { id: "qwen-web", create: () => new QwenProvider() },
  deepseek: { id: "deepseek-web", create: () => new DeepSeekProvider() },
  kimi: { id: "kimi-web", create: () => new KimiProvider() },
  zai: { id: "zai-web", create: () => new ZaiProvider() },
};

export function apply(ctx: Context, config: Config): void {
  // Before any provider exists: the bridges read their settings when built.
  installHost(config);

  const routes: Route[] = config.providers.map((key) => {
    const provider = BACKENDS[key].create();
    return { id: BACKENDS[key].id, name: provider.displayName, provider };
  });
  const adapter = new FreeAiAdapter(routes, new FileSecretStore(), config.autoSignIn);
  ctx.llm.registerAdapter(
    routes.map((route) => route.id),
    adapter,
  );

  // Closes the browser bridges when the plugin unloads or the harness stops.
  ctx.effect(
    () => () => {
      for (const route of routes) route.provider.dispose();
    },
    "free-ai.providers",
  );
}
