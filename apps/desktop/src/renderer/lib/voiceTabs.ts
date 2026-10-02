/**
 * Voice ownership across the tabs of one browser (#40). Tabs share the auth session, so they
 * share the LiveKit identity `<user_id>:<session_id>` and the server's voice seat of the device.
 * When one tab joins voice, every other tab in voice must let go *locally*: a /voice/leave from
 * the old tab would take the new tab's seat (same session) out of the room, and an old tab left
 * in another room would keep publishing there while the server shows the device elsewhere (each
 * tab's seat check would then re-join its own room in turn). LiveKit's DUPLICATE_IDENTITY covers
 * only the same room; this BroadcastChannel claim covers any room. Event-driven, no timers.
 */

export const VOICE_TABS_CHANNEL = 'calaba:voice';

/** A tab's voice join intent, broadcast to the other tabs of the browser. */
export interface VoiceClaim {
  session: string;
  at: number;
  nonce: string;
}

export function parseClaim(data: unknown): VoiceClaim | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.session !== 'string' || typeof d.at !== 'number' || typeof d.nonce !== 'string') return null;
  return { session: d.session, at: d.at, nonce: d.nonce };
}

/**
 * This tab (auth session `session`, last own claim `mine`) gives voice up to `other`: same auth
 * session and `other` is the newer intent (two simultaneous joins: exactly one side yields).
 */
export function yieldsTo(session: string, mine: VoiceClaim | null, other: VoiceClaim): boolean {
  if (!session || other.session !== session) return false;
  if (!mine) return true;
  if (other.at !== mine.at) return other.at > mine.at;
  return other.nonce > mine.nonce;
}
