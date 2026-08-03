/**
 * Which sub-providers are compiled in is decided at build time by esbuild
 * (`PROVIDER_<NAME>=false`, see esbuild.js); the value is substituted for
 * `__ENABLED_PROVIDERS__`. Outside a build (tests, ts-node) all are enabled.
 */
declare const __ENABLED_PROVIDERS__: string[] | undefined;

export const ALL_PROVIDERS = ["qwen", "deepseek", "kimi"] as const;
export type ProviderKey = (typeof ALL_PROVIDERS)[number];

const enabled: ReadonlySet<string> =
  typeof __ENABLED_PROVIDERS__ !== "undefined"
    ? new Set(__ENABLED_PROVIDERS__)
    : new Set(ALL_PROVIDERS);

/** Providers enabled in this build, in declaration order. */
export function enabledProviders(): ProviderKey[] {
  return ALL_PROVIDERS.filter((key) => enabled.has(key));
}
