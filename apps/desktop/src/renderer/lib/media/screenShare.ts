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
import { publishOptionalAudio, type StreamAudioProblem } from './streamAudio';

export type { StreamAudioProblem } from './streamAudio';

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

export type ScreenCodec = 'av1' | 'vp9' | 'h264' | 'vp8';

const MIME: Record<ScreenCodec, string> = { av1: 'video/av1', vp9: 'video/vp9', h264: 'video/h264', vp8: 'video/vp8' };

/** Codecs this runtime can encode for WebRTC (RTCRtpSender capabilities). */
export function encodableCodecs(): Set<ScreenCodec> {
  const caps = typeof RTCRtpSender !== 'undefined' ? (RTCRtpSender.getCapabilities('video')?.codecs ?? []) : [];
  const mimes = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  return new Set((Object.keys(MIME) as ScreenCodec[]).filter((k) => mimes.has(MIME[k])));
}

/**
 * AV1 per ADR-0012. Browsers without an AV1 WebRTC encoder (Firefox, Safari — web
 * client, ADR-0015) fall back to VP9, then VP8; the SFU forwards whatever was published.
 * `preferred` (picker → «Дополнительно») wins when this runtime can encode it.
 */
export function pickScreenCodec(preferred: ScreenCodec | 'auto' = 'auto', available: Set<ScreenCodec> = encodableCodecs()): ScreenCodec {
  if (preferred !== 'auto' && available.has(preferred)) return preferred;
  if (available.has('av1')) return 'av1';
  if (available.has('vp9')) return 'vp9';
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
  /** Codec override (default 'auto' = ADR-0012). */
  codec?: ScreenCodec | 'auto';
}

export interface ActiveScreenShare {
  video: LocalVideoTrack;
  audio: LocalAudioTrack | null;
  audioProblem: StreamAudioProblem;
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
): Promise<CapturedScreen> {
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
      if (stream.getAudioTracks().length > 0) return { stream, audioProblem: null };
      return { stream, audioProblem: { code: 'no-loopback', raw: null } };
    } catch (err) {
      // Known: custom picker + audio on macOS (electron#52738). Retry video-only.
      await platform.capture.selectSource({ sourceId: source.id, audio: false });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      return { stream, audioProblem: { code: 'failed', raw: err } };
    }
  }
  await platform.capture.selectSource({ sourceId: source.id, audio: false });
  const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  return { stream, audioProblem: null };
}

export interface CapturedScreen {
  stream: MediaStream;
  audioProblem: StreamAudioProblem;
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
  const codec = pickScreenCodec(opts.codec ?? 'auto');
  const publishOpts: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8/H.264: plain simulcast (no scalabilityMode in libwebrtc); AV1/VP9 use L1T3 per simulcast layer.
    ...(codec === 'vp8' || codec === 'h264' ? {} : { scalabilityMode: 'L1T3' as const }),
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
  let audioProblem = cap.audioProblem;
  if (audioTrack) {
    const track = new LocalAudioTrack(audioTrack, undefined, true);
    // Optional: a failed audio publish must not leave the video half-published (continue video-only).
    const problem = await publishOptionalAudio(
      () => lp.publishTrack(track, { source: Track.Source.ScreenShareAudio, audioPreset: AudioPresets.musicStereo, dtx: false, red: false }),
      () => {
        void lp.unpublishTrack(track, true).catch(() => undefined);
        audioTrack.stop();
      },
    );
    if (problem) audioProblem = problem;
    else audio = track;
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
  return { video, audio, audioProblem, sourceName, stop };
}
