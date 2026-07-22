import { aliasResolver } from "../common/models";
import type { AIModelInfo } from "../types";

/** Model route as mimocode names it (`mimo models` prints `providerID/modelID`). */
export interface MimoModelRoute {
  providerID: string;
  modelID: string;
}

/**
 * Only the free anonymous MiMo Auto channel — no key, no sign-in. Paid
 * `xiaomi/*` routes are hidden on purpose: they need a MiMo account.
 * Limits come from the local server's `GET /config/providers`.
 */
export const MIMO_MODELS: AIModelInfo[] = [
  {
    id: "mimo-auto",
    name: "MiMo Auto",
    family: "MiMo",
    maxInputTokens: 1000000,
    maxOutputTokens: 128000,
    capabilities: {
      toolCalling: true,
      streaming: true,
      thinking: true,
      imageInput: true,
      chat: true,
      fix: true,
      suggestions: false,
      commit: false,
    },
  },
];

const MIMO_MODEL_ROUTES: Record<string, MimoModelRoute> = {
  "mimo-auto": { providerID: "mimo", modelID: "mimo-auto" },
};

export const resolveMimoModelId = aliasResolver({
  mimo: "mimo-auto",
  default: "mimo-auto",
  auto: "mimo-auto",
});

export function getMimoRoute(id: string): MimoModelRoute | undefined {
  return MIMO_MODEL_ROUTES[resolveMimoModelId(id)];
}

/** `providerID/modelID` → our model id (filters the `mimo models` output). */
export function findModelIdByRoute(route: string): string | undefined {
  const normalized = route.trim().toLowerCase();
  return Object.entries(MIMO_MODEL_ROUTES).find(
    ([, r]) => `${r.providerID}/${r.modelID}`.toLowerCase() === normalized,
  )?.[0];
}
