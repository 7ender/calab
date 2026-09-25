import { SCREEN_SHARE_PRESETS, type ConcreteScreenSharePreset, type ScreenShareContentHint } from '@calaba/protocol';
import {
  AudioPresets,
  LocalAudioTrack,
  LocalVideoTrack,
  Track,
  VideoPreset,
  type LocalParticipant,
  type TrackPublishOptions,
} from 'livekit-client';
import { platform } from '../../platform';

/**
 * Screen share publishing per ADR-0012 (refines ADR-0005):
 * AV1 + simulcast, every rid encoded as L1T3, no backup codec.
 *
 * Why simulcast: livekit-client forces L1T3 + contentHint 'motion' on a
 * non-simulcast SVC screen share; its "SVC simulcast" path (livekit-server ≥
 * 1.13.7) keeps our contentHint and gives viewers a real 640×360 layer for
 * the PiP tile, while dynacast stops encoding the full layer nobody watches.
 */
const THUMB_LAYER = { width: 640, height: 360, maxBitrate: 250_000 };

type Codec = 'av1' | 'vp9' | 'vp8';

/**
 * AV1 per ADR-0012. Browsers without an AV1 WebRTC encoder (Firefox, Safari — web
 * client, ADR-0015) fall back to VP9, then VP8; the SFU forwards whatever was published.
 */
export function pickScreenCodec(): Codec {
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const has = (mime: string): boolean => codecs.some((c) => c.mimeType.toLowerCase() === mime);
  if (has('video/av1')) return 'av1';
  if (has('video/vp9')) return 'vp9';
  return 'vp8';
}

export interface DesktopSource {
  id: string;
  name: string;
}

export interface ScreenShareOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
}

export interface ActiveScreenShare {
  video: LocalVideoTrack;
  audio: LocalAudioTrack | null;
  /** Human-readable reason system audio is absent although requested. */
  audioError: string | null;
  sourceName: string;
  stop(): Promise<void>;
}

/** Chromium-only audio constraints not yet in lib.dom. */
interface DisplayAudioConstraints extends MediaTrackConstraints {
  restrictOwnAudio?: boolean;
  suppressLocalAudioPlayback?: boolean;
}

function videoConstraints(preset: ConcreteScreenSharePreset): MediaTrackConstraints {
  const p = SCREEN_SHARE_PRESETS[preset];
  const c: MediaTrackConstraints = { frameRate: { ideal: p.fps, max: p.fps } };
  // width/height 0 = "original": native resolution.
  if (p.width > 0) c.width = { max: p.width };
  if (p.height > 0) c.height = { max: p.height };
  return c;
}

async function captureDesktop(
  source: DesktopSource,
  preset: ConcreteScreenSharePreset,
  systemAudio: boolean,
): Promise<{ stream: MediaStream; audioError: string | null }> {
  const video = videoConstraints(preset);
  if (systemAudio) {
    const audio: DisplayAudioConstraints = {
      // Try to exclude our own output (other participants' voices) — rule 4.
      // NOTE: measured ineffective on macOS (docs/02 spike results), hence the UI warning.
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      await platform.capture.selectSource({ sourceId: source.id, audio: true });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
      if (stream.getAudioTracks().length > 0) return { stream, audioError: null };
      return { stream, audioError: 'система не отдала звук (loopback не поддерживается)' };
    } catch (err) {
      // Known: custom picker + audio on macOS (electron#52738). Retry video-only.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await platform.capture.selectSource({ sourceId: source.id, audio: false });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      return { stream, audioError: `захват со звуком не удался (${msg}); стрим без звука` };
    }
  }
  await platform.capture.selectSource({ sourceId: source.id, audio: false });
  const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  return { stream, audioError: null };
}

export interface CapturedScreen {
  stream: MediaStream;
  audioError: string | null;
}

/**
 * Step 1: capture. Must run first, straight from the user's click: browsers require
 * transient activation for getDisplayMedia() (web client, ADR-0015).
 */
export function captureScreen(opts: ScreenShareOptions): Promise<CapturedScreen> {
  return captureDesktop(opts.source, opts.preset, opts.systemAudio);
}

/** Re-applies the (possibly lower, server-granted) preset to an already captured track. */
export async function applyPreset(cap: CapturedScreen, preset: ConcreteScreenSharePreset): Promise<void> {
  const t = cap.stream.getVideoTracks()[0];
  if (t) await t.applyConstraints(videoConstraints(preset)).catch(() => undefined);
}

/** Step 2: publish (after the stream slot is reserved). */
export async function startScreenShare(
  lp: LocalParticipant,
  opts: ScreenShareOptions,
  onEnded: () => void,
  captured?: CapturedScreen,
): Promise<ActiveScreenShare> {
  const preset = SCREEN_SHARE_PRESETS[opts.preset];
  const cap = captured ?? (await captureDesktop(opts.source, opts.preset, opts.systemAudio));
  const videoTrack = cap.stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('getDisplayMedia returned no video track');
  const audioTrack = cap.stream.getAudioTracks()[0] ?? null;

  // Encoder hint: 'detail' keeps text sharp (drops fps), 'motion' keeps fps.
  videoTrack.contentHint = opts.contentHint;
  const video = new LocalVideoTrack(videoTrack, undefined, true);
  const codec = pickScreenCodec();
  const publishOpts: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8 has no scalabilityMode in libwebrtc; AV1/VP9 use L1T3 per simulcast layer.
    ...(codec === 'vp8' ? {} : { scalabilityMode: 'L1T3' as const }),
    screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps },
    screenShareSimulcastLayers: [
      new VideoPreset(THUMB_LAYER.width, THUMB_LAYER.height, THUMB_LAYER.maxBitrate, preset.fps),
    ],
    degradationPreference: opts.contentHint === 'detail' ? 'maintain-resolution' : 'balanced',
  };
  try {
    await lp.publishTrack(video, publishOpts);
  } catch (err) {
    cap.stream.getTracks().forEach((t) => t.stop());
    throw err;
  }

  let audio: LocalAudioTrack | null = null;
  if (audioTrack) {
    audio = new LocalAudioTrack(audioTrack, undefined, true);
    await lp.publishTrack(audio, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: AudioPresets.musicStereo,
      dtx: false,
      red: false,
    });
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await lp.unpublishTrack(video, true).catch(() => undefined);
    if (audio) await lp.unpublishTrack(audio, true).catch(() => undefined);
  };
  // User stopped sharing from the OS UI, or the shared window closed.
  videoTrack.addEventListener('ended', () => {
    void stop().then(onEnded);
  });

  // Web: the browser picked the source; its label is the best name we have.
  const sourceName = opts.source.name || videoTrack.label || 'Экран';
  return { video, audio, audioError: cap.audioError, sourceName, stop };
}
