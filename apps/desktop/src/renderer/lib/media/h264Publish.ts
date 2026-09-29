import { ParticipantEvent, type LocalParticipant, type Track } from 'livekit-client';
import { log } from '../log';
import { h264Layout, preferH264High, type H264Layout, type H264Profile } from './h264';

/**
 * LiveKit glue of the H.264 profile and layer alignment (the why: lib/media/h264.ts, docs/02 «Кодек»).
 */

/** Tracks to publish as H.264 High (set by the publisher right before `publishTrack`). */
const highTracks = new WeakSet<Track>();

/** Publish `track` (next `publishTrack`, and republishes after a reconnect) as H.264 High. */
export function setH264Profile(track: Track, profile: H264Profile | undefined): void {
  if (profile === 'high') highTracks.add(track);
  else highTracks.delete(track);
}

/** The environment the hook needs; injected in tests. */
export interface H264HookEnv {
  capabilities: () => RTCRtpCodec[];
  log: (msg: string, err?: unknown) => void;
}

const defaultHookEnv: H264HookEnv = {
  capabilities: () => (typeof RTCRtpSender !== 'undefined' ? (RTCRtpSender.getCapabilities('video')?.codecs ?? []) : []),
  log: (msg, err) => log.warn(msg, err),
};

/** Sets H.264 High preferences on `transceiver`; false = not possible (left as is). */
export function applyH264High(transceiver: RTCRtpTransceiver, env: H264HookEnv = defaultHookEnv): boolean {
  const prefs = preferH264High(env.capabilities());
  if (!prefs || typeof transceiver.setCodecPreferences !== 'function') return false;
  try {
    transceiver.setCodecPreferences(prefs);
    return true;
  } catch (err) {
    env.log('h264: setCodecPreferences failed, publishing the default profile', err);
    return false;
  }
}

/**
 * Wires the H.264 High preferences into a room's local participant (once per Room). Runs inside
 * livekit-client's publish, between `addTransceiver` and the offer (see the module doc).
 */
export function installH264ProfileHook(lp: LocalParticipant, transceivers: () => RTCRtpTransceiver[] | undefined, env: H264HookEnv = defaultHookEnv): () => void {
  const onSender = (sender: RTCRtpSender, track: Track): void => {
    if (!highTracks.has(track)) return;
    const tr = transceivers()?.find((t) => t.sender === sender);
    if (tr) applyH264High(tr, env);
  };
  lp.on(ParticipantEvent.LocalSenderCreated, onSender);
  return () => {
    lp.off(ParticipantEvent.LocalSenderCreated, onSender);
  };
}

/** Minimal ImageCapture (lib.dom lacks it): one frame of the track, to learn its real size. */
type GrabFrame = (track: MediaStreamTrack) => Promise<{ width: number; height: number; close?: () => void }>;

const defaultGrab: GrabFrame | null =
  typeof globalThis !== 'undefined' && 'ImageCapture' in globalThis
    ? (track) => new (globalThis as unknown as { ImageCapture: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }).ImageCapture(track).grabFrame()
    : null;

/**
 * The size frames really have. A screen / window capture reports the *requested* size (e.g. the
 * preset's 1920×1080) until its first frame, and ScreenCaptureKit picks the real one only then
 * (1658×1078 for a Retina screen, docs/14 «Стрим экрана: захват»): aligning to the reported size
 * left the thumb odd (553×359) and in OpenH264. So wait for one frame (≤ `timeoutMs`, then trust
 * the settings); without ImageCapture (Firefox / Safari) the settings are all there is.
 */
export async function realFrameSize(track: MediaStreamTrack, grab: GrabFrame | null = defaultGrab, timeoutMs = 1500): Promise<{ width: number; height: number }> {
  if (grab) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const frame = await Promise.race([grab(track), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), timeoutMs)))]);
      if (frame) {
        frame.close?.();
        if (frame.width > 0 && frame.height > 0) return { width: frame.width, height: frame.height };
      }
    } catch {
      // No frame (ended track, unsupported source): fall back to the settings.
    } finally {
      clearTimeout(timer);
    }
  }
  const s = track.getSettings();
  return { width: s.width ?? 0, height: s.height ?? 0 };
}

/**
 * Aligns a live capture for H.264 (see `h264Layout`) and pins it there: crops-and-scales it to the
 * aligned size with `exact` constraints, keeping the frame-rate cap (`applyConstraints` replaces the
 * whole set). Pinned even when the size is aligned already: a screen / window capture may still
 * change its size (ScreenCaptureKit reconfigures when it sees the content, Chromium's capture
 * oracle adapts the resolution), and a later odd size would silently move a layer to OpenH264
 * (+5 % of a core on M4, docs/14). Returns the layout the capture now has, or null when it could
 * not be aligned (publish as is).
 */
export async function alignCaptureForH264(track: MediaStreamTrack, layerShortSides: readonly number[], fps: number | undefined, grab: GrabFrame | null = defaultGrab): Promise<H264Layout | null> {
  const size = await realFrameSize(track, grab);
  const layout = h264Layout(size.width, size.height, layerShortSides);
  if (!layout) return null;
  const c: MediaTrackConstraints & { resizeMode?: string } = {
    width: { exact: layout.width },
    height: { exact: layout.height },
    resizeMode: 'crop-and-scale',
  };
  if (fps) c.frameRate = { ideal: fps, max: fps };
  try {
    await track.applyConstraints(c);
  } catch (err) {
    log.warn('h264: could not align the capture', err);
    return null;
  }
  const now = track.getSettings();
  return now.width === layout.width && now.height === layout.height ? layout : null;
}
