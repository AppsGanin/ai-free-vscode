import * as vscode from "vscode";
import { errToString, log } from "../logger";
import type { UnifiedProvider } from "../providers/UnifiedProvider";
import { listModels } from "../providers/openai/OpenAICompatApiClient";
import type { OpenAICompatProvider } from "../providers/openai/OpenAICompatProvider";
import {
  type CustomProviderConfig,
  customProviderId,
  normalizeBaseUrl,
  readCustomProviders,
  secretKey,
  slugify,
  writeCustomProviders,
} from "../providers/openai/customConfig";

/** Settings the page owns, in the order the UI shows them. */
const FEATURE_SETTINGS = [
  "freeAI.commit.enabled",
  "freeAI.commit.model",
  "freeAI.commit.prompt",
  "freeAI.suggestions.enabled",
  "freeAI.suggestions.model",
  "freeAI.suggestions.maxPrefixChars",
  "freeAI.suggestions.maxSuffixChars",
  "freeAI.fix.enabled",
  "freeAI.fix.model",
  "freeAI.debug",
  "freeAI.qwen.browserMode",
  "freeAI.mimo.path",
  "freeAI.playwright.timeout",
] as const;

export interface SettingsPanelDeps {
  provider: UnifiedProvider;
  secrets: vscode.SecretStorage;
  /** Live instances, replaced whenever the endpoint list changes. */
  customProviders: () => OpenAICompatProvider[];
}

/** Payload the webview sends back for an endpoint form. */
interface DraftConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  noApiKey: boolean;
  models: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  imageInput: boolean;
  thinking: boolean;
  headers: string;
}

let panel: vscode.WebviewPanel | undefined;

export function registerSettingsPanel(
  context: vscode.ExtensionContext,
  deps: SettingsPanelDeps,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("free-ai-vscode.settings", () =>
      showSettingsPanel(context, deps),
    ),
  );
}

export async function showSettingsPanel(
  context: vscode.ExtensionContext,
  deps: SettingsPanelDeps,
): Promise<void> {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, "media");
  panel = vscode.window.createWebviewPanel(
    "freeAiVscodeSettings",
    "AI Free VSCode",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    },
  );

  const current = panel;
  current.iconPath = vscode.Uri.joinPath(mediaRoot, "icon.png");
  current.webview.html = await loadHtml(current.webview, mediaRoot);

  const postState = () => {
    void buildState(deps).then((state) => {
      current.webview.postMessage({ type: "state", payload: state });
    });
  };
  const notify = (text: string, ok: boolean, models?: string[]) => {
    current.webview.postMessage({ type: "notice", text, ok, models });
  };
  /** Closes the endpoint form. Silent: the list itself is the confirmation. */
  const notifySaved = () => {
    current.webview.postMessage({ type: "saved" });
  };

  const subscriptions = [
    // Covers sign-ins, endpoint rebuilds and refreshed model lists alike.
    deps.provider.onDidAuthChange(postState),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("freeAI")) postState();
    }),
  ];

  current.onDidDispose(() => {
    for (const item of subscriptions) item.dispose();
    panel = undefined;
  });

  current.webview.onDidReceiveMessage(
    async (message: { type: string } & Record<string, unknown>) => {
      try {
        await handleMessage(message, deps, postState, notify, notifySaved);
      } catch (err) {
        log(`[settings] ${message.type} failed — ${errToString(err)}`);
        notify(errToString(err), false);
      }
    },
  );

  postState();
}

async function handleMessage(
  message: { type: string } & Record<string, unknown>,
  deps: SettingsPanelDeps,
  postState: () => void,
  notify: (text: string, ok: boolean, models?: string[]) => void,
  notifySaved: () => void,
): Promise<void> {
  switch (message.type) {
    case "ready":
      postState();
      return;

    case "signIn":
      await vscode.commands.executeCommand(
        "free-ai-vscode.login",
        String(message.id),
      );
      return;

    case "signOut":
      await vscode.commands.executeCommand(
        "free-ai-vscode.logout",
        String(message.id),
      );
      return;

    case "setSetting": {
      const key = String(message.key);
      if (!(FEATURE_SETTINGS as readonly string[]).includes(key)) {
        throw new Error(`Unknown setting: ${key}`);
      }
      await vscode.workspace
        .getConfiguration()
        .update(key, message.value, vscode.ConfigurationTarget.Global);
      return;
    }

    case "openJson":
      await vscode.commands.executeCommand(
        "workbench.action.openSettingsJson",
        { revealSetting: { key: "freeAI.custom.providers" } },
      );
      return;

    case "saveProvider": {
      await saveProvider(
        message.config as unknown as DraftConfig,
        message.apiKey as string | undefined,
        message.clearKey === true,
        deps,
      );
      notifySaved();
      postState();
      return;
    }

    case "deleteProvider": {
      const id = String(message.id);
      const existing = readCustomProviders();
      const target = existing.find((cfg) => cfg.id === id);
      if (!target) return;

      // Removing takes the stored key with it, so ask first.
      const confirm = await vscode.window.showWarningMessage(
        `Remove "${target.name}"?`,
        { modal: true, detail: "Its models and stored API key are deleted." },
        "Remove",
      );
      if (confirm !== "Remove") return;

      await writeCustomProviders(existing.filter((cfg) => cfg.id !== id));
      await deps.secrets.delete(secretKey(id));
      log(`[settings] endpoint "${id}" removed`);
      postState();
      return;
    }

    case "refreshModels": {
      const id = String(message.id);
      const provider = findProvider(deps, id);
      if (!provider) throw new Error(`Endpoint not found: ${id}`);
      const models = await provider.refreshModels(deps.secrets);
      notify(`${provider.displayName}: ${models.length} model(s).`, true);
      postState();
      return;
    }

    case "testProvider": {
      const draft = message.config as unknown as DraftConfig;
      const config = toConfig(draft, draft.id || slugify(draft.name));
      const apiKey =
        (message.apiKey as string) ||
        (await deps.secrets.get(secretKey(config.id))) ||
        undefined;

      const models = await listModels({
        providerId: customProviderId(config.id),
        config,
        apiKey,
      });
      notify(
        models.length
          ? `Connected — ${models.length} model(s) loaded.`
          : "Connected, but the endpoint listed no models.",
        true,
        models,
      );
      return;
    }

    default:
      log(`[settings] ignored message: ${message.type}`);
  }
}

async function saveProvider(
  draft: DraftConfig,
  apiKey: string | undefined,
  clearKey: boolean,
  deps: SettingsPanelDeps,
): Promise<CustomProviderConfig> {
  const existing = readCustomProviders();
  const id = draft.id || uniqueId(slugify(draft.name), existing);
  const config = toConfig(draft, id);

  if (!config.name || !config.baseUrl) {
    throw new Error("Name and base URL are required.");
  }

  const index = existing.findIndex((cfg) => cfg.id === id);
  const next =
    index >= 0
      ? existing.map((cfg, i) => (i === index ? config : cfg))
      : [...existing, config];

  // The key first: a settings write rebuilds the providers, and the new one
  // should find its credentials already in place.
  if (clearKey) {
    await deps.secrets.delete(secretKey(id));
  } else if (apiKey) {
    await deps.secrets.store(secretKey(id), apiKey);
  }

  await writeCustomProviders(next);
  log(`[settings] endpoint "${id}" saved (${config.baseUrl})`);
  return config;
}

function toConfig(draft: DraftConfig, id: string): CustomProviderConfig {
  const models = (draft.models ?? [])
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model }));

  return {
    id,
    name: draft.name.trim(),
    baseUrl: normalizeBaseUrl(draft.baseUrl ?? ""),
    enabled: draft.enabled !== false,
    noApiKey: draft.noApiKey === true,
    ...(models.length ? { models } : {}),
    maxInputTokens: positive(draft.maxInputTokens, 128000),
    maxOutputTokens: positive(draft.maxOutputTokens, 8192),
    toolCalling: draft.toolCalling !== false,
    imageInput: draft.imageInput === true,
    thinking: draft.thinking === true,
    ...(parseHeaders(draft.headers)
      ? { headers: parseHeaders(draft.headers) }
      : {}),
  };
}

/** Invalid JSON must not block a save — the endpoint works without headers. */
function parseHeaders(raw: string): Record<string, string> | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const entries = Object.entries(parsed).filter(
      ([, value]) => typeof value === "string",
    ) as Array<[string, string]>;
    return entries.length ? Object.fromEntries(entries) : undefined;
  } catch {
    log(`[settings] extra headers are not valid JSON — ignored`);
    return undefined;
  }
}

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function uniqueId(base: string, existing: CustomProviderConfig[]): string {
  if (!existing.some((cfg) => cfg.id === base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.some((cfg) => cfg.id === candidate)) return candidate;
  }
}

function findProvider(
  deps: SettingsPanelDeps,
  configId: string,
): OpenAICompatProvider | undefined {
  return deps
    .customProviders()
    .find((provider) => provider.config.id === configId);
}

async function buildState(deps: SettingsPanelDeps) {
  const { provider, secrets } = deps;
  const authStates = await provider.getProviderAuthStates(secrets);
  const authById = new Map(authStates.map((state) => [state.id, state]));
  const instances = deps.customProviders();

  const custom = [];
  for (const config of readCustomProviders()) {
    const instance = instances.find((p) => p.config.id === config.id);
    custom.push({
      config,
      hasKey: !!(await secrets.get(secretKey(config.id))),
      // `name` carries the upstream id: that is what the endpoint knows.
      models: instance?.getModels().map((model) => model.name) ?? [],
      authenticated:
        authById.get(customProviderId(config.id))?.authenticated ?? false,
    });
  }

  const available = await provider.getAvailableModels(secrets);
  const configuration = vscode.workspace.getConfiguration();

  return {
    builtIn: authStates
      .filter((state) => !state.custom)
      .map(({ id, name, authenticated }) => ({ id, name, authenticated })),
    custom,
    models: available.map((model) => ({
      id: model.id,
      name: model.name,
      family: model.family,
      capabilities: (["commit", "suggestions", "fix"] as const).filter(
        (capability) => model.capabilities[capability] !== false,
      ),
    })),
    // Keyed by setting id: the page binds controls through `data-setting`,
    // so a new setting needs markup only, no code on either side.
    settings: Object.fromEntries(
      FEATURE_SETTINGS.map((key) => [key, configuration.get(key)]),
    ),
  };
}

/**
 * The page itself lives in `media/settings/`, as a normal HTML/CSS/JS trio —
 * the asset URLs and the script nonce are the only things the host fills in.
 */
async function loadHtml(
  webview: vscode.Webview,
  mediaRoot: vscode.Uri,
): Promise<string> {
  const asset = (name: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, "settings", name));

  const bytes = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(mediaRoot, "settings", "index.html"),
  );

  return Buffer.from(bytes)
    .toString("utf-8")
    .replaceAll("{{cspSource}}", webview.cspSource)
    .replaceAll("{{nonce}}", createNonce())
    .replaceAll("{{styleUri}}", asset("style.css").toString())
    .replaceAll("{{scriptUri}}", asset("main.js").toString());
}

function createNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
