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
      await window.calaba.capture.selectSource({ sourceId: source.id, audio: true });
      const stream = await navigator.mediaDevices.getDisplayMedia({ video, audio });
      if (stream.getAudioTracks().length > 0) return { stream, audioError: null };
      return { stream, audioError: 'система не отдала звук (loopback не поддерживается)' };
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
  const cap = await captureDesktop(opts.source, opts.preset, opts.systemAudio);
  const videoTrack = cap.stream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('getDisplayMedia returned no video track');
  const audioTrack = cap.stream.getAudioTracks()[0] ?? null;

  // Encoder hint: 'detail' keeps text sharp (drops fps), 'motion' keeps fps.
  videoTrack.contentHint = opts.contentHint;
  const video = new LocalVideoTrack(videoTrack, undefined, true);
  const publishOpts: TrackPublishOptions = {
    source: Track.Source.ScreenShare,
    videoCodec: 'av1',
    backupCodec: false,
    simulcast: true,
    scalabilityMode: 'L1T3',
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

  return { video, audio, audioError: cap.audioError, sourceName: opts.source.name, stop };
}
