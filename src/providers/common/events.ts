/** Subscription handle; VS Code's Disposable has the same shape. */
export interface Disposable {
  dispose(): void;
}

/** Subscribes a listener; same call shape as `vscode.Event`. */
export type Event<T> = (listener: (value: T) => unknown) => Disposable;

/** Minimal event source, so the providers do not need VS Code's EventEmitter. */
export class Emitter<T> implements Disposable {
  private listeners = new Set<(value: T) => unknown>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}
