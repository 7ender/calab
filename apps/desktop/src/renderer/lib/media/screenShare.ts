import {
  SCREEN_SHARE_PRESETS,
  SCREEN_SHARE_SCALABILITY_MODE,
  type ConcreteScreenSharePreset,
  type ScreenShareContentHint,
} from '@calaba/protocol';
import {
  AudioPresets,
  LocalAudioTrack,
  LocalVideoTrack,
  Track,
  VideoPreset,
  type LocalParticipant,
  type ScalabilityMode,
  type TrackPublishOptions,
  type VideoCodec,
} from 'livekit-client';
import { startTestPattern, type TestPattern, type TestPatternKind } from './testPattern';

/**
 * Scalability mode choice; 'auto' = by contentHint per ADR-0005.
 *
 * NOTE (spike finding): for a *non-simulcast* SVC screen share livekit-client
 * 2.22 forces `L1T3` and overrides contentHint to 'motion' regardless of what
 * we pass. 'L1T3_SIMULCAST' uses its "SVC simulcast" path instead (AV1/VP9 as
 * rid simulcast, each rid L1T3; needs livekit-server > 1.13.6), which keeps
 * our contentHint and gives adaptive stream a real low-resolution layer.
 */
export type ScalabilityChoice = 'auto' | 'L1T1' | 'L1T3' | 'L2T3_KEY' | 'L3T3_KEY' | 'L1T3_SIMULCAST';
export const SCALABILITY_CHOICES: ScalabilityChoice[] = [
  'auto',
  'L1T3',
  'L2T3_KEY',
  'L3T3_KEY',
  'L1T1',
  'L1T3_SIMULCAST',
];

/** Low simulcast layer for 'L1T3_SIMULCAST': thumbnail-sized, same fps as the preset. */
const THUMB_LAYER = { width: 640, height: 360, maxBitrate: 250_000 };

export type SpikeVideoCodec = Extract<VideoCodec, 'av1' | 'vp9' | 'h264'>;
export const VIDEO_CODECS: SpikeVideoCodec[] = ['av1', 'vp9', 'h264'];

export type ScreenSource = { kind: 'desktop'; id: string; name: string } | { kind: 'test'; pattern: TestPatternKind };

export interface ScreenShareOptions {
  source: ScreenSource;
  preset: ConcreteScreenSharePreset;
  contentHint: ScreenShareContentHint;
  scalability: ScalabilityChoice;
  codec: SpikeVideoCodec;
  systemAudio: boolean;
}

export interface ActiveScreenShare {
  video: LocalVideoTrack;
  audio: LocalAudioTrack | null;
  /** Human-readable reason system audio is absent although requested. */
  audioError: string | null;
  scalabilityMode: ScalabilityMode | null;
  simulcast: boolean;
  /** contentHint actually on the track after publish (livekit-client may override it). */
  effectiveContentHint: string;
  sourceName: string;
  stop(): Promise<void>;
}

export function resolveScalability(choice: ScalabilityChoice, hint: ScreenShareContentHint): ScalabilityMode {
  if (choice === 'auto') return SCREEN_SHARE_SCALABILITY_MODE[hint];
  return choice === 'L1T3_SIMULCAST' ? 'L1T3' : choice;
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
  source: { id: string },
  preset: ConcreteScreenSharePreset,
  systemAudio: boolean,
): Promise<{ stream: MediaStream; audioError: string | null }> {
  const video = videoConstraints(preset);
  if (systemAudio) {
    const audio: DisplayAudioConstraints = {
      // Exclude our own process output (other participants' voices) — rule 4.
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      await window.calaba.capture.selectSource({ sourceId: source.id, audio: true });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
      if (stream.getAudioTracks().length > 0) return { stream, audioError: null };
      return { stream, audioError: 'система не отдала аудио-трек (платформа не поддерживает loopback)' };
    } catch (err) {
      // Known: custom picker + audio on macOS (electron#52738). Retry video-only.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await window.calaba.capture.selectSource({ sourceId: source.id, audio: false });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
      return { stream, audioError: `захват со звуком не удался (${msg}); стрим без звука` };
    }
  }
  await window.calaba.capture.selectSource({ sourceId: source.id, audio: false });
  const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  return { stream, audioError: null };
}

export async function startScreenShare(
  lp: LocalParticipant,
  opts: ScreenShareOptions,
  onEnded: () => void,
): Promise<ActiveScreenShare> {
  const preset = SCREEN_SHARE_PRESETS[opts.preset];
  let pattern: TestPattern | null = null;
  let videoTrack: MediaStreamTrack;
  let audioTrack: MediaStreamTrack | null = null;
  let audioError: string | null = null;
  let sourceName: string;

  if (opts.source.kind === 'test') {
    // "original" has no fixed size: emulate a 2560×1600 Retina screen.
    const w = preset.width || 2560;
    const h = preset.height || 1600;
    pattern = startTestPattern(opts.source.pattern, w, h, preset.fps);
    videoTrack = pattern.track;
    sourceName = `Тест: ${opts.source.pattern === 'static' ? 'статичный текст' : 'скролл текста'} ${w}×${h}`;
    if (opts.systemAudio) audioError = 'тестовый источник без звука';
  } else {
    const cap = await captureDesktop(opts.source, opts.preset, opts.systemAudio);
    const v = cap.stream.getVideoTracks()[0];
    if (!v) throw new Error('getDisplayMedia returned no video track');
    videoTrack = v;
    audioTrack = cap.stream.getAudioTracks()[0] ?? null;
    audioError = cap.audioError;
    sourceName = opts.source.name;
  }

  // Encoder hint: 'detail' keeps text sharp (drops fps), 'motion' keeps fps.
  videoTrack.contentHint = opts.contentHint;
  const scalabilityMode = opts.codec === 'h264' ? null : resolveScalability(opts.scalability, opts.contentHint);
  const simulcast = opts.codec === 'h264' || opts.scalability === 'L1T3_SIMULCAST';

  const video = new LocalVideoTrack(videoTrack, undefined, true);
  const publishOpts: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    videoCodec: opts.codec,
    // ADR-0005: Electron-only clients share one decoder set → no backup codec.
    backupCodec: false,
    screenShareEncoding: { maxBitrate: preset.maxBitrate, maxFramerate: preset.fps },
    degradationPreference: opts.contentHint === 'detail' ? 'maintain-resolution' : 'balanced',
    // SVC codecs carry layers in one stream; H.264 has no SVC in libwebrtc → simulcast.
    simulcast,
    ...(simulcast
      ? {
          screenShareSimulcastLayers: [
            new VideoPreset(THUMB_LAYER.width, THUMB_LAYER.height, THUMB_LAYER.maxBitrate, preset.fps),
          ],
        }
      : {}),
    ...(scalabilityMode ? { scalabilityMode } : {}),
  };
  await lp.publishTrack(video, publishOpts);
  // livekit-client may rewrite scalabilityMode/contentHint (see ScalabilityChoice);
  // report what the encoder actually got.
  const actualMode =
    (video.sender?.getParameters().encodings[0] as { scalabilityMode?: string } | undefined)?.scalabilityMode ?? null;

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
    await lp.unpublishTrack(video, true);
    if (audio) await lp.unpublishTrack(audio, true);
    pattern?.stop();
  };
  // User stopped sharing from the OS UI, or the window closed.
  videoTrack.addEventListener('ended', () => {
    void stop().then(onEnded);
  });

  return {
    video,
    audio,
    audioError,
    scalabilityMode: (actualMode as ScalabilityMode | null) ?? scalabilityMode,
    simulcast,
    effectiveContentHint: videoTrack.contentHint,
    sourceName,
    stop,
  };
}
