/**
 * Pure voice-state rules (unit-tested). docs/02-media.md, "Режимы микрофона":
 * explicit mute is signalled to LiveKit; the VAD gate / PTT only toggle audio flow.
 */
export interface SelfState {
  muted: boolean;
  deafened: boolean;
}

/** Mic button: unmuting while deafened also undeafens (Discord behaviour). */
export function toggleMute(s: SelfState): SelfState {
  if (s.muted || s.deafened) return { muted: false, deafened: false };
  return { muted: true, deafened: false };
}

/** Deafen = mute + silence all remote audio. */
export function toggleDeafen(s: SelfState): SelfState {
  return s.deafened ? { muted: false, deafened: false } : { muted: true, deafened: true };
}

export interface TransmitInput extends SelfState {
  canSpeak: boolean;
  mode: 'voice' | 'ptt';
  gateOpen: boolean;
  pttDown: boolean;
}

export interface TransmitDecision {
  /** LiveKit `track.mute()` — visible to others as "muted". */
  livekitMuted: boolean;
  /** `mediaStreamTrack.enabled` — silence without signalling. */
  audioEnabled: boolean;
  /** UI "on air" indicator. */
  transmitting: boolean;
}

export function transmitDecision(i: TransmitInput): TransmitDecision {
  const livekitMuted = i.muted || i.deafened || !i.canSpeak;
  const gate = i.mode === 'voice' ? i.gateOpen : i.pttDown;
  return { livekitMuted, audioEnabled: gate, transmitting: !livekitMuted && gate };
}

export type LinkQuality = 'good' | 'fair' | 'poor' | 'unknown';

/** Connection quality dot from RTT (ms) and packet loss (%). */
export function qualityOf(rttMs: number | null, lossPct: number | null): LinkQuality {
  if (rttMs === null && lossPct === null) return 'unknown';
  const r = rttMs ?? 0;
  const l = lossPct ?? 0;
  if (r < 150 && l < 2) return 'good';
  if (r < 300 && l < 8) return 'fair';
  return 'poor';
}

/** LiveKit protocol TrackSource.MICROPHONE. */
const LK_SOURCE_MICROPHONE = 2;

/**
 * SPEAK from our LiveKit grant: the server lists the allowed sources (rtc/grant.go), so a
 * stream-only grant (`canPublish` with screen sources) must not count as SPEAK.
 */
export function canSpeakFrom(p: { canPublish: boolean; canPublishSources: readonly number[] }): boolean {
  return p.canPublish && (p.canPublishSources.length === 0 || p.canPublishSources.includes(LK_SOURCE_MICROPHONE));
}

/** getUserMedia failed because the chosen device is gone (unplugged / id changed). */
export function isDeviceGone(err: unknown): boolean {
  const name = typeof err === 'object' && err !== null && 'name' in err ? err.name : null;
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError';
}
