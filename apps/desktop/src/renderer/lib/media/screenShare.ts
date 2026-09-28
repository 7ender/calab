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
import { t } from '../../i18n';
import { capFps } from '../plan';
import type { PublishCodec } from './codecSelect';

export type { StreamAudioProblem } from './streamAudio';

/**
 * Screen share publishing per ADR-0012 (refines ADR-0005), codec per ADR-0032: simulcast (a
 * 640×360 thumb layer + the preset), no backup codec. The codec comes from `pickPublishCodec`
 * (lib/media/codecSelect.ts): H.264 by default — hardware where the machine has it — AV1 on request.
 *
 * Why simulcast: livekit-client forces L1T3 + contentHint 'motion' on a
 * non-simulcast SVC screen share; its "SVC simulcast" path (livekit-server ≥
 * 1.13.7) keeps our contentHint and gives viewers a real 640×360 layer for
 * the PiP tile, while dynacast stops encoding the full layer nobody watches.
 * H.264 has no SVC: plain rid simulcast with the same two layers; livekit-client leaves
 * contentHint alone on that path (it only rewrites it for non-simulcast SVC).
 */
const THUMB_LAYER = { width: 640, height: 360, maxBitrate: 250_000 };

/**
 * Text in H.264 needs more bits than in AV1 for the same sharpness (ADR-0032 §4, docs/02):
 * «detail» streams get +40 % on both layers' caps.
 */
export const H264_DETAIL_BITRATE_FACTOR = 1.4;

export type ScreenCodec = PublishCodec;

/** A layer's bitrate cap for this codec and content (ADR-0032 §4). */
export function screenBitrate(base: number, codec: ScreenCodec, hint: ScreenShareContentHint): number {
  return codec === 'h264' && hint === 'detail' ? Math.round(base * H264_DETAIL_BITRATE_FACTOR) : base;
}

/** Publish options of a screen share at `fps` (already capped by the grant). Pure, unit-tested. */
export function screenPublishOptions(codec: ScreenCodec, preset: ConcreteScreenSharePreset, hint: ScreenShareContentHint, fps: number): TrackPublishOptions {
  const p = SCREEN_SHARE_PRESETS[preset];
  return {
    source: Track.Source.ScreenShare,
    videoCodec: codec,
    backupCodec: false,
    simulcast: true,
    // VP8/H.264: plain simulcast (no scalabilityMode in libwebrtc); AV1/VP9 use L1T3 per simulcast layer.
    ...(codec === 'vp8' || codec === 'h264' ? {} : { scalabilityMode: 'L1T3' as const }),
    screenShareEncoding: { maxBitrate: screenBitrate(p.maxBitrate, codec, hint), maxFramerate: fps },
    screenShareSimulcastLayers: [new VideoPreset(THUMB_LAYER.width, THUMB_LAYER.height, screenBitrate(THUMB_LAYER.maxBitrate, codec, hint), fps)],
    degradationPreference: hint === 'detail' ? 'maintain-resolution' : 'balanced',
  };
}

export interface DesktopSource {
  id: string;
  name: string;
  /** A whole screen's display id (desktop): the presenter's annotation overlay covers it (ADR-0028). */
  displayId?: string;
}

export interface ScreenShareOptions {
  source: DesktopSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  systemAudio: boolean;
  /** Codec to publish with: `pickPublishCodec('screen', pref)` (ADR-0032). Default H.264. */
  codec?: ScreenCodec;
  /**
   * Frame rate granted by /stream/request (the plan's stream_max_fps, ADR-0024): capture and
   * encoding never go above it. Unset / 0 = the preset's own.
   */
  fps?: number;
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

function videoConstraints(preset: ConcreteScreenSharePreset, grantedFps?: number): MediaTrackConstraints {
  const p = SCREEN_SHARE_PRESETS[preset];
  const fps = capFps(p.fps, grantedFps);
  const c: MediaTrackConstraints = { frameRate: { ideal: fps, max: fps } };
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

/** Re-applies the (possibly lower, server-granted) preset and frame rate to an already captured track. */
export async function applyPreset(cap: CapturedScreen, preset: ConcreteScreenSharePreset, fps?: number): Promise<void> {
  const t = cap.stream.getVideoTracks()[0];
  if (t) await t.applyConstraints(videoConstraints(preset, fps)).catch(() => undefined);
}

/** Step 2: publish (after the stream slot is reserved). */
export async function startScreenShare(
  lp: LocalParticipant,
  opts: ScreenShareOptions,
  onEnded: () => void,
  captured?: CapturedScreen,
): Promise<ActiveScreenShare> {
  // Never encode above the frame rate the server granted (the plan's cap, ADR-0024).
  const fps = capFps(SCREEN_SHARE_PRESETS[opts.preset].fps, opts.fps);
  const cap = captured ?? (await captureDesktop(opts.source, opts.preset, opts.systemAudio));
  const videoTrack = cap.stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('getDisplayMedia returned no video track');
  const audioTrack = cap.stream.getAudioTracks()[0] ?? null;

  // Encoder hint: 'detail' keeps text sharp (drops fps), 'motion' keeps fps.
  videoTrack.contentHint = opts.contentHint;
  const video = new LocalVideoTrack(videoTrack, undefined, true);
  const publishOpts = screenPublishOptions(opts.codec ?? 'h264', opts.preset, opts.contentHint, fps);
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
  const sourceName = opts.source.name || videoTrack.label || t('common.screen');
  return { video, audio, audioProblem, sourceName, stop };
}
