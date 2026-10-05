/**
 * The slice of the `vscode` API the providers and the adapter touch. Parts the
 * adapter reports are recorded with a `kind`, so a test can read the order the
 * chat UI would receive them in.
 */

const settings: Record<string, unknown> = {};

/**
 * Overrides a setting for the current test: `"http.proxy"` with its section,
 * or a bare key, which any section answers to.
 */
export function setSetting(key: string, value: unknown): void {
  if (value === undefined) delete settings[key];
  else settings[key] = value;
}

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, fallback?: T): T => {
      const full = section ? `${section}.${key}` : key;
      if (full in settings) return settings[full] as T;
      return (key in settings ? settings[key] : fallback) as T;
    },
  }),
};

export const notifications: string[] = [];

export const window = {
  showWarningMessage: async (message: string) => {
    notifications.push(message);
    return undefined;
  },
  showInformationMessage: async (message: string) => {
    notifications.push(message);
    return undefined;
  },
  showErrorMessage: async (message: string) => {
    notifications.push(message);
    return undefined;
  },
  showQuickPick: async () => undefined,
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => undefined };
  };
  fire(e: T): void {
    for (const listener of this.listeners) listener(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Disposable {
  constructor(private readonly onDispose: () => void = () => undefined) {}
  dispose(): void {
    this.onDispose();
  }
}

export const LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 3 };
export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };

export class LanguageModelTextPart {
  readonly kind = "text";
  constructor(public value: string) {}
}

export class LanguageModelThinkingPart {
  readonly kind = "thinking";
  constructor(public value: string | string[]) {}
}

export class LanguageModelToolCallPart {
  readonly kind = "tool";
  constructor(
    public callId: string,
    public name: string,
    public input: Record<string, unknown>,
  ) {}
}

export class LanguageModelToolResultPart {
  readonly kind = "toolResult";
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}

export class LanguageModelDataPart {
  readonly kind = "data";
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}

export class LanguageModelPromptTsxPart {
  readonly kind = "tsx";
  constructor(public value: unknown) {}
}

export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}
