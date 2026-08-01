import * as vscode from "vscode";
import { log } from "../../logger";

/**
 * User-defined OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp,
 * OpenRouter, any gateway that speaks `/chat/completions`).
 *
 * Everything except the API key lives in settings, so it syncs and can be
 * edited by hand; the key goes to SecretStorage under `secretKey(id)`.
 */
const SECTION = "freeAI.custom";
const KEY = "providers";

export const DEFAULT_MAX_INPUT_TOKENS = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface CustomModelConfig {
  /** Model id as the endpoint knows it, e.g. `qwen2.5-coder:7b`. */
  id: string;
  /** Label in the picker; defaults to the id. */
  name?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
}

export interface CustomProviderConfig {
  /** Slug, unique across endpoints. Part of every model id and of the secret key. */
  id: string;
  name: string;
  /** Base URL including the version segment, e.g. `http://localhost:1234/v1`. */
  baseUrl: string;
  enabled?: boolean;
  /** Local servers need no key; without this an endpoint with no key is "signed out". */
  noApiKey?: boolean;
  /** Explicit list. When empty, models come from `GET {baseUrl}/models`. */
  models?: CustomModelConfig[];
  /** Defaults applied to every model of this endpoint. */
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  thinking?: boolean;
  /** Extra request headers, e.g. `HTTP-Referer` for OpenRouter. */
  headers?: Record<string, string>;
}

/** Namespace, so `gpt-4o-mini` on two endpoints stays two distinct models. */
const MODEL_PREFIX = "custom:";

export function toCustomModelId(
  providerId: string,
  upstreamId: string,
): string {
  return `${MODEL_PREFIX}${providerId}/${upstreamId}`;
}

/** Splits a namespaced id back apart; upstream ids may contain `/` themselves. */
export function fromCustomModelId(
  modelId: string,
): { providerId: string; upstreamId: string } | undefined {
  if (!modelId.startsWith(MODEL_PREFIX)) return undefined;
  const rest = modelId.slice(MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return undefined;
  return {
    providerId: rest.slice(0, slash),
    upstreamId: rest.slice(slash + 1),
  };
}

/** Provider id as seen by the rest of the extension (auth states, logs). */
export function customProviderId(configId: string): string {
  return `ai-free-vscode-custom-${configId}`;
}

export function isCustomProviderId(providerId: string): boolean {
  return providerId.startsWith("ai-free-vscode-custom-");
}

export function secretKey(configId: string): string {
  return `ai-free-vscode.custom.${configId}.key`;
}

/** `LM Studio (local)` → `lm-studio-local`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "endpoint";
}

/**
 * Trailing slash off; a bare origin gets `/v1` appended, which is what every
 * OpenAI-compatible server uses and the mistake users make most often.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") {
      return `${url.origin}/v1`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

export function readCustomProviders(): CustomProviderConfig[] {
  const raw = vscode.workspace
    .getConfiguration()
    .get<unknown[]>(`${SECTION}.${KEY}`, []);

  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const result: CustomProviderConfig[] = [];

  for (const entry of raw) {
    const cfg = normalizeConfig(entry);
    if (!cfg) continue;
    if (seen.has(cfg.id)) {
      log(`[custom] duplicate provider id "${cfg.id}" ignored`);
      continue;
    }
    seen.add(cfg.id);
    result.push(cfg);
  }

  return result;
}

export async function writeCustomProviders(
  providers: CustomProviderConfig[],
): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(`${SECTION}.${KEY}`, providers, vscode.ConfigurationTarget.Global);
}

/** True when a settings change touched the endpoint list. */
export function affectsCustomProviders(
  event: vscode.ConfigurationChangeEvent,
): boolean {
  return event.affectsConfiguration(`${SECTION}.${KEY}`);
}

/** Drops entries that could not work at all; fills in the defaults. */
function normalizeConfig(entry: unknown): CustomProviderConfig | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as Record<string, unknown>;

  const name = str(raw.name) || str(raw.id);
  const baseUrl = normalizeBaseUrl(str(raw.baseUrl));
  if (!name || !baseUrl) {
    log(`[custom] skipping an endpoint without a name or baseUrl`);
    return undefined;
  }

  const models = Array.isArray(raw.models)
    ? raw.models
        .map(normalizeModel)
        .filter((m): m is CustomModelConfig => m !== undefined)
    : undefined;

  return {
    id: slugify(str(raw.id) || name),
    name,
    baseUrl,
    enabled: raw.enabled !== false,
    noApiKey: raw.noApiKey === true,
    ...(models?.length ? { models } : {}),
    maxInputTokens: num(raw.maxInputTokens) ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: num(raw.maxOutputTokens) ?? DEFAULT_MAX_OUTPUT_TOKENS,
    toolCalling: raw.toolCalling !== false,
    imageInput: raw.imageInput === true,
    thinking: raw.thinking === true,
    ...(isStringMap(raw.headers) ? { headers: raw.headers } : {}),
  };
}

function normalizeModel(entry: unknown): CustomModelConfig | undefined {
  if (typeof entry === "string") {
    return entry.trim() ? { id: entry.trim() } : undefined;
  }
  if (!entry || typeof entry !== "object") return undefined;

  const raw = entry as Record<string, unknown>;
  const id = str(raw.id);
  if (!id) return undefined;

  return {
    id,
    ...(str(raw.name) ? { name: str(raw.name) } : {}),
    ...(num(raw.maxInputTokens) !== undefined
      ? { maxInputTokens: num(raw.maxInputTokens) }
      : {}),
    ...(num(raw.maxOutputTokens) !== undefined
      ? { maxOutputTokens: num(raw.maxOutputTokens) }
      : {}),
    ...(typeof raw.toolCalling === "boolean"
      ? { toolCalling: raw.toolCalling }
      : {}),
    ...(typeof raw.imageInput === "boolean"
      ? { imageInput: raw.imageInput }
      : {}),
    ...(typeof raw.thinking === "boolean" ? { thinking: raw.thinking } : {}),
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}
