/**
 * One tab per event (#40): tabs of one browser share the auth session and each has its own
 * gateway session, so every tab receives the same MESSAGE_CREATE. Sounds and system
 * notifications must fire once, not once per tab. The first tab to take the Web Lock
 * `calaba:once:<key>` wins; it holds the lock for HOLD_MS so a slower tab finds it taken.
 * A hidden tab tries HIDDEN_DELAY_MS later, so the tab on screen wins (it knows whether the
 * chat is open). One one-shot timer per notifying event — nothing runs while idle.
 */

export const HOLD_MS = 10_000;
export const HIDDEN_DELAY_MS = 150;

export interface LockManagerLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | undefined): Promise<unknown>;
}

export interface CrossTabDeps {
  /** null = a single-window host (desktop) or no Web Locks: every event is ours. */
  locks: LockManagerLike | null;
  hidden(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
}

/**
 * `true` (synchronously) when there is no other tab to share with; else resolves whether this
 * tab owns the event `key`.
 */
export function claimOnce(key: string, deps: CrossTabDeps): true | Promise<boolean> {
  const locks = deps.locks;
  if (!locks) return true;
  return new Promise((resolve) => {
    const attempt = (): void => {
      locks
        .request(`calaba:once:${key}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          resolve(true);
          return new Promise<void>((done) => void deps.setTimeout(done, HOLD_MS));
        })
        .catch(() => resolve(true)); // locks unusable: better twice than never
    };
    if (deps.hidden()) deps.setTimeout(attempt, HIDDEN_DELAY_MS);
    else attempt();
  });
}

/** Runs fn once across the tabs of this browser for event `key` (now, when not shared). */
export function onceAcrossTabs(key: string, deps: CrossTabDeps, fn: () => void): void {
  const owned = claimOnce(key, deps);
  if (owned === true) fn();
  else void owned.then((ok) => ok && fn());
}
