/**
 * Список всех известных под-провайдеров и их build-time состояние.
 *
 * Какие провайдеры попадают в сборку, решается на этапе сборки (esbuild),
 * через переменные окружения `PROVIDER_<NAME>=false`. См. esbuild.js.
 * Значение подставляется компилятором вместо `__ENABLED_PROVIDERS__`.
 *
 * Вне сборки (тесты, ts-node) константа не определена — тогда включены все.
 */
declare const __ENABLED_PROVIDERS__: string[] | undefined;

/** Ключи всех существующих под-провайдеров. */
export const ALL_PROVIDERS = ["qwen", "deepseek", "kimi"] as const;
export type ProviderKey = (typeof ALL_PROVIDERS)[number];

const enabled: ReadonlySet<string> =
  typeof __ENABLED_PROVIDERS__ !== "undefined"
    ? new Set(__ENABLED_PROVIDERS__)
    : new Set(ALL_PROVIDERS);

/** Включён ли провайдер в текущей сборке. */
export function isProviderEnabled(key: ProviderKey): boolean {
  return enabled.has(key);
}

/** Ключи провайдеров, включённых в текущей сборке (в исходном порядке). */
export function enabledProviders(): ProviderKey[] {
  return ALL_PROVIDERS.filter((key) => enabled.has(key));
}
