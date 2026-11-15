/**
 * Tiny external store for React's useSyncExternalStore.
 *
 * Controllers keep a mutable model and call `touch()` whenever it changes. The immutable
 * snapshot is rebuilt at most every `intervalMs`: engine progress fires per block, which
 * would otherwise re-render the TUI thousands of times per second.
 */
export class Store<T> {
  #snapshot: T;
  #build: () => T;
  #listeners = new Set<() => void>();
  #timer: NodeJS.Timeout | null = null;
  #intervalMs: number;

  constructor(build: () => T, intervalMs = 80) {
    this.#build = build;
    this.#snapshot = build();
    this.#intervalMs = intervalMs;
  }

  get = (): T => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Mark the model as changed; publishes a fresh snapshot soon (or now). */
  touch(immediate = false): void {
    if (immediate) {
      this.#flush();
      return;
    }
    if (!this.#timer) {
      this.#timer = setTimeout(() => this.#flush(), this.#intervalMs);
    }
  }

  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.clear();
  }

  #flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }
}
