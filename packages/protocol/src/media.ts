import { ScreenSharePreset, type RoomMediaSettings } from './gen/calaba/v1/media_pb.js';

/** A concrete preset (UNSPECIFIED excluded). */
export type ConcreteScreenSharePreset = Exclude<ScreenSharePreset, ScreenSharePreset.UNSPECIFIED>;

/**
 * Screen share presets, keyed by the generated enum (proto/calaba/v1/media.proto is the
 * source of truth for the preset set). Bitrate is a cap, not usage (docs/02-media.md).
 */
export const SCREEN_SHARE_PRESETS: Record<
  ConcreteScreenSharePreset,
  { width: number; height: number; fps: number; maxBitrate: number }
> = {
  [ScreenSharePreset.ECONOMY]: { width: 1280, height: 720, fps: 5, maxBitrate: 400_000 },
  [ScreenSharePreset.H720]: { width: 1280, height: 720, fps: 15, maxBitrate: 1_000_000 },
  [ScreenSharePreset.H1080]: { width: 1920, height: 1080, fps: 15, maxBitrate: 2_000_000 },
  [ScreenSharePreset.ORIGINAL]: { width: 0, height: 0, fps: 30, maxBitrate: 4_000_000 },
};

export const DEFAULT_SCREEN_SHARE_PRESET: ConcreteScreenSharePreset = ScreenSharePreset.H1080;

/**
 * Voice quality tiers (kbps): a room setting with a workspace default, shown as words only
 * («Низкое / Нормальное / Хорошее / Отличное», docs/02 «Битрейт»). Each tier also caps the Opus
 * bandwidth (8 → telephone, 16 → wideband, 32 → super-wideband, 64 → fullband).
 */
export const AUDIO_TIERS_KBPS = [8, 16, 32, 64] as const;
export type AudioTierKbps = (typeof AUDIO_TIERS_KBPS)[number];
export const DEFAULT_AUDIO_BITRATE_KBPS: AudioTierKbps = 32;

/**
 * The tier of a stored bitrate. Rows from before the tiers may hold 24 or 48: they map to the
 * nearest tier, a tie going up (24 → 32, 48 → 64) so an old room never sounds worse than it did.
 */
export function audioTierKbps(kbps: number): AudioTierKbps {
  if (!Number.isFinite(kbps) || kbps <= 0) return DEFAULT_AUDIO_BITRATE_KBPS;
  let best: AudioTierKbps = AUDIO_TIERS_KBPS[0];
  for (const t of AUDIO_TIERS_KBPS) if (Math.abs(t - kbps) <= Math.abs(best - kbps)) best = t;
  return best;
}

/**
 * Opus in-band FEC stays on (libwebrtc default). RED is off by default:
 * it is an opt-in "unstable network" toggle in settings (ADR-0004).
 */
export const AUDIO_PUBLISH_DEFAULTS = {
  codec: 'opus',
  channels: 1,
  dtx: true,
  red: false,
} as const;

/**
 * Capture constraints. Built-in noise suppression is disabled while the RNNoise
 * worklet is on, to avoid double processing (docs/02-media.md).
 */
export function audioCaptureConstraints(rnnoiseEnabled: boolean): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: !rnnoiseEnabled,
    autoGainControl: true,
    channelCount: 1,
  };
}

/**
 * `MediaStreamTrack.contentHint` of a screen share. Both hints publish AV1 simulcast with L1T3
 * layers (ADR-0012 superseded the per-hint SVC table of ADR-0005, which is gone).
 */
export type ScreenShareContentHint = 'detail' | 'motion';

/**
 * Preset not above the room maximum (`room.media.maxStreamPreset`).
 * Enum values are ordered by quality. UNSPECIFIED is treated as the default preset.
 */
export function clampStreamPreset(
  wanted: ScreenSharePreset,
  max: ScreenSharePreset,
): ConcreteScreenSharePreset {
  const w = wanted === ScreenSharePreset.UNSPECIFIED ? DEFAULT_SCREEN_SHARE_PRESET : wanted;
  const m = max === ScreenSharePreset.UNSPECIFIED ? DEFAULT_SCREEN_SHARE_PRESET : max;
  return (w <= m ? w : m) as ConcreteScreenSharePreset;
}

export const MAX_STREAMS_PER_ROOM_DEFAULT = 3;

/** Workspace-level defaults for rooms without overrides (mirrors the DB column defaults). */
export const DEFAULT_ROOM_MEDIA_SETTINGS: Pick<RoomMediaSettings, 'audioBitrateKbps' | 'maxStreamPreset' | 'maxStreams'> = {
  audioBitrateKbps: DEFAULT_AUDIO_BITRATE_KBPS,
  maxStreamPreset: DEFAULT_SCREEN_SHARE_PRESET,
  maxStreams: MAX_STREAMS_PER_ROOM_DEFAULT,
};
