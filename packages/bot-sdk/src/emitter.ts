export type Listener<T> = (arg: T) => unknown;

/**
 * A tiny typed event emitter. A listener that throws or returns a rejected promise is reported through
 * `onListenerError` (the Bot turns it into an `error` event); it never breaks the event loop of the SDK.
 */
export class Emitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();

  constructor(private readonly onListenerError: (err: unknown, event: keyof E) => void) {}

  on<K extends keyof E>(event: K, fn: Listener<E[K]>): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  once<K extends keyof E>(event: K, fn: Listener<E[K]>): this {
    const wrapped: Listener<E[K]> = (arg) => {
      this.off(event, wrapped);
      return fn(arg);
    };
    return this.on(event, wrapped);
  }

  off<K extends keyof E>(event: K, fn: Listener<E[K]>): this {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  protected emit<K extends keyof E>(event: K, arg: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set] as Listener<E[K]>[]) {
      try {
        const r = fn(arg);
        if (r instanceof Promise) {
          r.catch((err: unknown) => {
            this.onListenerError(err, event);
          });
        }
      } catch (err) {
        this.onListenerError(err, event);
      }
    }
  }
}
