import { errToString, log } from "../../logger";

/**
 * Which scenario and model a plain chat goes to. Read from the web app's own
 * list (`GetAvailableModels`, `defaultChatModel`): kimi.ai and kimi.com offer
 * different models, and both lists move with every release. Agent scenarios
 * (OK Computer) are skipped on purpose: they run the model inside Kimi's own
 * server-side tool environment.
 */
export interface KimiChatTarget {
  scenario: string;
  /** Model id for `options.model`; absent for the legacy scenario. */
  model?: string;
}

const MODELS_PATH = "/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels";
/** What the client sent before the list existed; still answered. */
export const LEGACY_TARGET: KimiChatTarget = { scenario: "SCENARIO_K2D5" };
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A failed lookup is retried sooner, but not on every request. */
const FAILED_MAX_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

interface ModelEntry {
  id?: string;
  scenario?: string;
}

const cache = new Map<string, { target: KimiChatTarget; expiresAt: number }>();

export async function chatTarget(origin: string, token: string): Promise<KimiChatTarget> {
  const cached = cache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.target;

  let target = LEGACY_TARGET;
  let maxAge = FAILED_MAX_AGE_MS;
  try {
    const response = await fetch(`${origin}${MODELS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        Origin: origin,
        Referer: `${origin}/`,
        "X-Msh-Platform": "web",
      },
      body: "{}",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const list = (await response.json()) as {
      defaultChatModel?: string;
      availableModels?: ModelEntry[];
      moreModels?: ModelEntry[];
    };
    const id = list.defaultChatModel;
    const entry = [...(list.availableModels ?? []), ...(list.moreModels ?? [])].find(
      (model) => model.id === id && model.scenario === "SCENARIO_CHAT",
    );
    if (entry?.id && entry.scenario) {
      target = { scenario: entry.scenario, model: entry.id };
      maxAge = MAX_AGE_MS;
    } else {
      log(`[kimi-api] no plain chat model in the list (HTTP ${response.status}), using ${LEGACY_TARGET.scenario}`);
    }
  } catch (err) {
    log(`[kimi-api] could not read the model list, using ${LEGACY_TARGET.scenario} — ${errToString(err)}`);
  }
  if (target.model) log(`[kimi-api] chat model for ${origin}: ${target.model}`);
  cache.set(origin, { target, expiresAt: Date.now() + maxAge });
  return target;
}

/** Test hook: forget what was read. */
export function resetChatTargets(): void {
  cache.clear();
}
