import { createProviderModelIdResolver } from "../common/ModelIdResolver";
import type { AIModelInfo } from "../types";

/**
 * Маршрут модели в терминах mimocode: `providerID/modelID`
 * (именно так CLI печатает их в `mimo models`).
 */
export interface MimoModelRoute {
  providerID: string;
  modelID: string;
}

/**
 * Только бесплатный анонимный канал MiMo Auto: он не требует ни ключа, ни входа.
 * Платные `xiaomi/*` намеренно не показываем — для них нужен аккаунт MiMo.
 *
 * Лимиты взяты из ответа `GET /config/providers` локального mimocode-сервера.
 */
export const MIMO_MODELS: AIModelInfo[] = [
  {
    id: "mimo-auto",
    name: "MiMo Auto (free)",
    family: "MiMo",
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    capabilities: { toolCalling: true, streaming: true },
  },
];

/** Наш ID модели → маршрут mimocode. */
export const MIMO_MODEL_ROUTES: Record<string, MimoModelRoute> = {
  "mimo-auto": { providerID: "mimo", modelID: "mimo-auto" },
};

/** Алиасы: короткое имя → канонический ID */
export const MIMO_MODEL_ALIASES: Record<string, string> = {
  mimo: "mimo-auto",
  default: "mimo-auto",
  auto: "mimo-auto",
};

const MIMO_MODEL_ID_RESOLVER = createProviderModelIdResolver({
  aliases: MIMO_MODEL_ALIASES,
});

/** Разрешает алиас в канонический ID модели */
export function resolveMimoModelId(id: string): string {
  return MIMO_MODEL_ID_RESOLVER.resolveModelId(id);
}

/** Маршрут `providerID/modelID` для нашего ID модели. */
export function getMimoRoute(id: string): MimoModelRoute | undefined {
  return MIMO_MODEL_ROUTES[resolveMimoModelId(id)];
}

/** `providerID/modelID` → наш ID модели (для фильтрации по выводу `mimo models`). */
export function findModelIdByRoute(route: string): string | undefined {
  const normalized = route.trim().toLowerCase();
  for (const [modelId, r] of Object.entries(MIMO_MODEL_ROUTES)) {
    if (`${r.providerID}/${r.modelID}`.toLowerCase() === normalized) {
      return modelId;
    }
  }
  return undefined;
}
