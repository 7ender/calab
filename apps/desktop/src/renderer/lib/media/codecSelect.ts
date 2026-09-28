/**
 * Publish codec by hardware (ADR-0032): ask `navigator.mediaCapabilities.encodingInfo` which
 * WebRTC encoder is `powerEfficient` (= hardware) and take the first of H.264 → AV1 → VP9.
 *
 * When none is hardware, the cheapest SOFTWARE encoder, not H.264: measured on an M4 in Electron 44
 * (docs/14 «Кодек по железу»), a 720p15 screen stream costs 38.7 % of a core with OpenH264 and
 * 23.2 % with AV1 (libaom, screen-content tools) — so the screen keeps AV1 (ADR-0012) and the
 * camera VP9 (ADR-0018). This amends ADR-0032 §1's «иначе H.264» (see the note there). Outside
 * Chromium only H.264 / VP8 (plain simulcast) are used.
 * The user can pin AV1 («Качество текста») or H.264 («Совместимость») in the settings.
 *
 * H.264 has two profiles here (lib/media/h264.ts, docs/02 «Кодек»): «Auto» probes and publishes
 * **High** `64001f` — the profile Chromium on macOS gives to VideoToolbox (a bare `video/H264`
 * probe means Constrained Baseline `42e01f`, which it never encodes in hardware, so «Auto» would
 * never see the hardware encoder). «Совместимость» is Constrained Baseline, the profile every
 * WebRTC decoder takes (software on macOS).
 *
 * Results are cached for the session (per kind and preference): the probe is async and the
 * answer does not change while the app runs. Tests inject their own `mediaCapabilities`.
 */

import { isChromium } from './cameraLogic';
import { H264_CONTENT_TYPE, h264ProfileOf, type H264Profile } from './h264';

export type PublishKind = 'screen' | 'camera';
export type CodecPref = 'auto' | 'av1' | 'h264';
export type PublishCodec = 'h264' | 'av1' | 'vp9' | 'vp8';
export type CodecDirection = 'encode' | 'decode';

export interface CodecPick {
  codec: PublishCodec;
  /** Hardware encoder per `encodingInfo(...).powerEfficient`; null = unknown (no API / probe failed). */
  hw: boolean | null;
  /** H.264 only: the profile to publish (High = setCodecPreferences hook, CB = LiveKit's default). */
  profile?: H264Profile;
}

/** What the probe needs; injected in tests. */
export interface CodecEnv {
  mediaCapabilities: Pick<MediaCapabilities, 'encodingInfo' | 'decodingInfo'> | null;
  /** Codecs this runtime can encode for WebRTC (RTCRtpSender capabilities). */
  encodable: ReadonlySet<PublishCodec>;
  /** VP9/AV1 rid simulcast with a per-rid scalabilityMode is unreliable outside Chromium (review L10). */
  chromium: boolean;
  /** The runtime encodes H.264 High (profile_idc 0x64): not Firefox's OpenH264. */
  h264High: boolean;
}

const MIME: Record<PublishCodec, string> = { h264: 'video/H264', av1: 'video/AV1', vp9: 'video/VP9', vp8: 'video/VP8' };

/** The size the probe asks about: the default stream preset (1080p15, 2 Mbps) / the camera's top layer. */
const PROBE: Record<PublishKind, { width: number; height: number; framerate: number; bitrate: number }> = {
  screen: { width: 1920, height: 1080, framerate: 15, bitrate: 2_000_000 },
  camera: { width: 1280, height: 720, framerate: 30, bitrate: 1_500_000 },
};

/** Hardware first, in this order (ADR-0032). */
const HW_ORDER: readonly PublishCodec[] = ['h264', 'av1', 'vp9'];

/** No hardware encoder: cheapest software encoder per kind (measured, docs/14), then plain-simulcast ones. */
const SW_ORDER: Record<PublishKind, readonly PublishCodec[]> = {
  screen: ['av1', 'vp9', 'h264', 'vp8'],
  camera: ['vp9', 'av1', 'h264', 'vp8'],
};

function defaultEnv(): CodecEnv {
  const caps = typeof RTCRtpSender !== 'undefined' ? (RTCRtpSender.getCapabilities('video')?.codecs ?? []) : [];
  const mimes = new Set(caps.map((c) => c.mimeType.toLowerCase()));
  const encodable = new Set((Object.keys(MIME) as PublishCodec[]).filter((k) => mimes.has(MIME[k].toLowerCase())));
  const h264High = caps.some((c) => c.mimeType.toLowerCase() === 'video/h264' && ['high', 'constrained-high'].includes(h264ProfileOf(c.sdpFmtpLine) ?? ''));
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return { mediaCapabilities: nav?.mediaCapabilities ?? null, encodable, chromium: !nav || isChromium(nav.userAgent), h264High };
}

let env: CodecEnv | null = null;
const probes = new Map<string, Promise<boolean | null>>();
const picks = new Map<string, Promise<CodecPick>>();

/** Tests: a fake environment (and a fresh cache). `null` = back to the real one. */
export function setCodecEnv(e: CodecEnv | null): void {
  env = e;
  probes.clear();
  picks.clear();
}

function currentEnv(): CodecEnv {
  env ??= defaultEnv();
  return env;
}

/** Normalises a stats / SDP codec name («H264», «video/AV1») to ours; null for anything else. */
export function toPublishCodec(name: string | null | undefined): PublishCodec | null {
  const n = (name ?? '').toLowerCase().replace(/^video\//, '');
  return n === 'h264' || n === 'av1' || n === 'vp9' || n === 'vp8' ? n : null;
}

/** The probe's contentType: H.264 with its profile (a bare `video/H264` means CB `42e01f`). */
export function probeContentType(codec: PublishCodec, profile: H264Profile = 'cb'): string {
  return codec === 'h264' ? H264_CONTENT_TYPE[profile] : MIME[codec];
}

/**
 * `powerEfficient` of encoding / decoding `codec` (H.264: of `profile`, default Constrained
 * Baseline) for WebRTC at `kind`'s size (cached). null = unsupported, no API, or the probe threw.
 */
export function codecPowerEfficient(dir: CodecDirection, kind: PublishKind, codec: PublishCodec, profile?: H264Profile): Promise<boolean | null> {
  const key = `${dir}:${kind}:${codec}:${codec === 'h264' ? (profile ?? 'cb') : ''}`;
  let p = probes.get(key);
  if (!p) {
    const mc = currentEnv().mediaCapabilities;
    const video = { contentType: probeContentType(codec, profile), ...PROBE[kind] };
    p = !mc
      ? Promise.resolve(null)
      : (dir === 'encode' ? mc.encodingInfo({ type: 'webrtc', video }) : mc.decodingInfo({ type: 'webrtc', video })).then(
          (r) => (r.supported ? r.powerEfficient : null),
          () => null,
        );
    probes.set(key, p);
  }
  return p;
}

async function pick(kind: PublishKind, pref: CodecPref): Promise<CodecPick> {
  const e = currentEnv();
  // Outside Chromium only codecs with plain simulcast (H.264, VP8) are safe to publish.
  const usable = (c: PublishCodec): boolean => e.encodable.has(c) && (e.chromium || c === 'h264' || c === 'vp8');
  // «Auto» publishes H.264 as High where the runtime encodes it; «Совместимость» and the software
  // fallback as Constrained Baseline (every decoder takes it).
  const autoProfile: H264Profile = e.h264High ? 'high' : 'cb';
  const hw = (c: PublishCodec, profile?: H264Profile): Promise<boolean | null> => codecPowerEfficient('encode', kind, c, profile);
  const withProfile = (c: PublishCodec, profile: H264Profile): Pick<CodecPick, 'profile'> => (c === 'h264' ? { profile } : {});

  if (pref !== 'auto' && usable(pref)) return { codec: pref, hw: await hw(pref, 'cb'), ...withProfile(pref, 'cb') };
  for (const c of HW_ORDER) if (usable(c) && (await hw(c, autoProfile)) === true) return { codec: c, hw: true, ...withProfile(c, autoProfile) };
  // Nothing in hardware: the cheapest software encoder (see the module doc), H.264 outside Chromium.
  const fallback = SW_ORDER[kind].find(usable) ?? 'vp8';
  return { codec: fallback, hw: e.encodable.has(fallback) ? await hw(fallback, 'cb') : null, ...withProfile(fallback, 'cb') };
}

/** The codec to publish `kind` with (ADR-0032), cached for the session. Never rejects. */
export function pickPublishCodec(kind: PublishKind, pref: CodecPref = 'auto'): Promise<CodecPick> {
  const key = `${kind}:${pref}`;
  let p = picks.get(key);
  if (!p) {
    p = pick(kind, pref);
    picks.set(key, p);
  }
  return p;
}

/** One side of the stats overlay's codec line: «H264 High hw», «AV1 sw», «VP9 ?» (unknown). */
export function codecHwLabel(codec: PublishCodec, hw: boolean | null, profileLabel?: string | null): string {
  const name = codec === 'h264' ? `H264${profileLabel ? ` ${profileLabel}` : ''}` : codec.toUpperCase();
  return `${name} ${hw === null ? '?' : hw ? 'hw' : 'sw'}`;
}
