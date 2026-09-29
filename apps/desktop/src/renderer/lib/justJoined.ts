import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';

/** How long the «just joined» dot stays next to a voice participant's avatar (owner, 29.09). */
export const JUST_JOINED_MS = 10_000;

/**
 * Clock skew we tolerate: `joined_at` is the server's clock. A join stamped further in the future
 * than this is not «just now» for this client (a badly set clock, a fixture with real time) —
 * without the guard the dot would stay for the whole skew.
 */
export const JUST_JOINED_SKEW_MS = 60_000;

/** VoiceState.joined_at → ms epoch (0 = unknown: the dot never shows). */
export function joinedAtMs(ts: Timestamp | undefined): number {
  return ts ? timestampMs(ts) : 0;
}

/**
 * When the dot's window ends (ms epoch), or null when it is not shown at all at `now`: no join
 * time, the window already passed, or a join stamped implausibly far in the future. `joined_at`
 * is the earliest join of the user's devices in the room (docs/05), so a reconnect or a second
 * device never restarts the window.
 */
export function justJoinedUntil(joinedAt: number, now: number): number | null {
  if (!joinedAt || joinedAt - now > JUST_JOINED_SKEW_MS) return null;
  const until = joinedAt + JUST_JOINED_MS;
  return now < until ? until : null;
}
