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

/**
 * Aligns a live capture for H.264 (see `h264Layout`): crops-and-scales it to the aligned size when
 * it is not already, keeping the frame-rate cap (`applyConstraints` replaces the whole set).
 * Returns the layout the capture now has, or null when it could not be aligned (publish as is).
 */
export async function alignCaptureForH264(track: MediaStreamTrack, layerShortSides: readonly number[], fps: number | undefined): Promise<H264Layout | null> {
  const s = track.getSettings();
  const layout = h264Layout(s.width ?? 0, s.height ?? 0, layerShortSides);
  if (!layout) return null;
  if (layout.width === s.width && layout.height === s.height) return layout;
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
