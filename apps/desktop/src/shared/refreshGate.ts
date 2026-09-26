/**
 * Token-refresh plumbing shared by the desktop token broker (main) and the web platform
 * (renderer). No Electron / DOM: unit-tested.
 */

/** A refresh (or any auth POST) that takes longer is aborted: a black-holed request must not
 *  keep the single-flight promise — and on the web the cross-tab Web Lock — forever (review N3). */
export const AUTH_TIMEOUT_MS = 15_000;

/** A transient refresh failure (`null`) is reused this long: no refresh storm during an outage. */
export const REFRESH_COOLDOWN_MS = 3_000;

export interface RefreshGate<T> {
  /** Joins the running refresh, returns a recent transient failure, or starts a new refresh. */
  run(): Promise<T | null>;
  /** Forget a cached failure (new login / logout). */
  reset(): void;
}

export interface RefreshGateOptions {
  cooldownMs?: number;
  now?: () => number;
  /** Whether a `null` result is a transient failure worth caching (default: always). */
  isTransient?: () => boolean;
}

/** Single-flight refresh with negative caching of a transient `null` (review N3). */
export function refreshGate<T>(refresh: () => Promise<T | null>, opts: RefreshGateOptions = {}): RefreshGate<T> {
  const cooldown = opts.cooldownMs ?? REFRESH_COOLDOWN_MS;
  const now = opts.now ?? ((): number => Date.now());
  let running: Promise<T | null> | null = null;
  let failedUntil = 0;
  let generation = 0;
  return {
    run() {
      if (running) return running;
      if (now() < failedUntil) return Promise.resolve(null);
      const gen = generation;
      running = refresh()
        .then((r) => {
          // A reset() during the request (login / logout) must not be undone by its late failure.
          if (r === null && gen === generation && (opts.isTransient?.() ?? true)) failedUntil = now() + cooldown;
          return r;
        })
        .finally(() => {
          running = null;
        });
      return running;
    },
    reset() {
      generation++;
      failedUntil = 0;
    },
  };
}
