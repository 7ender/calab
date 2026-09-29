/**
 * H.264 profile on the wire (docs/02 «Кодек», ADR-0032 note of 28.09, docs/14 «Аппаратный H.264
 * на macOS»).
 *
 * LiveKit v1.13 registers H.264 as Constrained Baseline `42e01f` first and High `640032` second and
 * orders its answer by that list, so with livekit-client's default offer every H.264 publish is
 * Constrained Baseline. Chromium on macOS never gives Constrained Baseline to VideoToolbox
 * (`IsH264ConstrainedBaselineProfileAvailableForAcceleratedEncoder`, webrtc_util.cc) — it encodes it
 * with OpenH264 in software. High `64001f` goes to VideoToolbox on every simulcast layer (720p/15
 * screen: 40.8 → 12.4 % of a core).
 *
 * «Auto» therefore publishes H.264 as High: before the first offer that carries the new video
 * transceiver, its codec preferences keep only the High-family H.264 entries (`preferH264High`).
 * Not Baseline `42001f` or Main: LiveKit (pion) matches H.264 by profile_idc only, so an offered
 * `42001f` matches its `42e01f` entry first and wins (seen on the dev LiveKit), and Main matches
 * nothing it registers. How, without a race (see `installH264ProfileHook` in h264Publish.ts):
 * livekit-client emits `ParticipantEvent.LocalSenderCreated` synchronously right after
 * `addTransceiver` and before it calls `engine.negotiate()` for that publish; the listener sets
 * `setCodecPreferences` there. No offer can be created in between (only microtasks run), and a
 * renegotiation the publish triggers later keeps the preferences (they live on the transceiver).
 * «Совместимость» leaves the default: Constrained Baseline, software.
 *
 * This module is pure (profiles, preferences, layer sizes); the LiveKit glue is h264Publish.ts.
 */

export type H264Profile = 'high' | 'cb';

/** `profile-level-id` names (RFC 6184 / webrtc `h264_profile_level_id.cc`). */
export type H264ProfileName = 'cb' | 'baseline' | 'main' | 'high' | 'constrained-high' | 'high444' | 'other';

/** `encodingInfo` / `decodingInfo` contentType of each publish profile (level 3.1 like LiveKit's). */
export const H264_CONTENT_TYPE: Record<H264Profile, string> = {
  high: 'video/H264; profile-level-id=64001f; packetization-mode=1',
  cb: 'video/H264; profile-level-id=42e01f; packetization-mode=1',
};

/** Masks of webrtc's `kProfilePatterns`: profile_idc + a bit pattern of profile_iop (x = any). */
const PATTERNS: ReadonlyArray<{ idc: number; pattern: string; name: H264ProfileName }> = [
  { idc: 0x42, pattern: 'x1xx0000', name: 'cb' },
  { idc: 0x4d, pattern: '1xxx0000', name: 'cb' },
  { idc: 0x58, pattern: '11xx0000', name: 'cb' },
  { idc: 0x42, pattern: 'x0xx0000', name: 'baseline' },
  { idc: 0x58, pattern: '10xx0000', name: 'baseline' },
  { idc: 0x4d, pattern: '0x0x0000', name: 'main' },
  { idc: 0x64, pattern: '00000000', name: 'high' },
  { idc: 0x64, pattern: '00001100', name: 'constrained-high' },
  { idc: 0xf4, pattern: '00000000', name: 'high444' },
];

function matches(iop: number, pattern: string): boolean {
  for (let i = 0; i < 8; i++) {
    const want = pattern[i];
    if (want === 'x') continue;
    const bit = (iop >> (7 - i)) & 1;
    if (String(bit) !== want) return false;
  }
  return true;
}

/** The profile of an H.264 `a=fmtp` / `sdpFmtpLine`; null when it has no profile-level-id. */
export function h264ProfileOf(fmtp: string | null | undefined): H264ProfileName | null {
  const m = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp ?? '');
  if (!m?.[1]) return null;
  const idc = parseInt(m[1].slice(0, 2), 16);
  const iop = parseInt(m[1].slice(2, 4), 16);
  return PATTERNS.find((p) => p.idc === idc && matches(iop, p.pattern))?.name ?? 'other';
}

/** Short overlay label: «High», «CB», «Main». */
export function h264ProfileLabel(p: H264ProfileName | null): string | null {
  if (!p) return null;
  const labels: Record<H264ProfileName, string> = {
    cb: 'CB',
    baseline: 'Baseline',
    main: 'Main',
    high: 'High',
    'constrained-high': 'CHigh',
    high444: 'High444',
    other: '?',
  };
  return labels[p];
}

/** The High family (profile_idc 0x64), in preference order: what LiveKit's `640032` entry matches. */
const RANK: Partial<Record<H264ProfileName, number>> = { high: 0, 'constrained-high': 1 };

const isH264 = (c: RTCRtpCodec): boolean => c.mimeType.toLowerCase() === 'video/h264';
const packetizationMode = (c: RTCRtpCodec): number => (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 1 : 0);

/**
 * Codec preferences for an H.264 High publish: of H.264 only High, then Constrained High
 * (packetization-mode 1 before 0), first; no Baseline / Constrained Baseline / Main (see the module
 * doc); every other codec (VP8/VP9/AV1, rtx, red, ulpfec) after in its own order. null = the runtime
 * cannot encode High (e.g. Firefox's OpenH264): leave the transceiver alone.
 */
export function preferH264High(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] | null {
  const h264 = codecs
    .filter((c) => isH264(c) && RANK[h264ProfileOf(c.sdpFmtpLine) ?? 'other'] !== undefined)
    .map((c, i) => ({ c, i, rank: RANK[h264ProfileOf(c.sdpFmtpLine) ?? 'other'] ?? 9 }))
    .sort((a, b) => a.rank - b.rank || packetizationMode(b.c) - packetizationMode(a.c) || a.i - b.i)
    .map((x) => x.c);
  if (h264.length === 0) return null;
  return [...h264, ...codecs.filter((c) => !isH264(c))];
}

/** Capture size and integer simulcast downscales that make every H.264 layer even. */
export interface H264Layout {
  width: number;
  height: number;
  /** Per requested layer (same order): the integer `scaleResolutionDownBy` against the capture. */
  scales: number[];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Hardware H.264 encoders take only even frame sizes (`rtc_video_encoder.cc` InitEncode) — an odd
 * layer silently falls back to OpenH264 (2560×1664 at the 720p preset is 1107×720, its thumb
 * 553×360). livekit-client derives each layer's `scaleResolutionDownBy` from the short sides
 * (capture / layer), libwebrtc truncates `size / scale`.
 *
 * So: every lower layer gets an integer scale (`round(captureShort / layerShort)`, ≥ 2 when the
 * layer is smaller than the capture, 1 otherwise), and the
 * capture is rounded down to a multiple of 2 × lcm(scales) — then capture / scale is even for every
 * layer. The caller publishes the lower layers at exactly `capture / scale` (`layerSize`), so
 * livekit-client computes the same integer scales. The crop is a few pixels.
 * null = unknown / too small a size.
 */
export function h264Layout(width: number, height: number, layerShortSides: readonly number[]): H264Layout | null {
  if (!(width > 0 && height > 0)) return null;
  const short = Math.min(width, height);
  // A layer below the capture is at least half of it (never a duplicate of the top layer). From the
  // largest layer down, each scale is a multiple of the previous one, so the lcm stays the smallest
  // layer's scale and the crop small (camera 180/360 at 720p: ×4, ×2 → a multiple of 8).
  const scales = layerShortSides.map(() => 1);
  let prev = 1;
  for (const i of layerShortSides.map((_, i) => i).sort((a, b) => (layerShortSides[b] ?? 0) - (layerShortSides[a] ?? 0))) {
    const l = layerShortSides[i] ?? short;
    const s = short <= l ? 1 : Math.max(2, Math.round(short / l));
    prev = Math.max(prev, Math.round(s / prev) * prev);
    scales[i] = prev;
  }
  const align = 2 * scales.reduce((a, b) => (a * b) / gcd(a, b), 1);
  const w = Math.floor(width / align) * align;
  const h = Math.floor(height / align) * align;
  if (w < align || h < align) return null;
  return { width: w, height: h, scales };
}

/** The size of layer `i` of a layout: capture / its integer scale (both even). */
export function layerSize(l: H264Layout, i: number): { width: number; height: number } {
  const s = l.scales[i] ?? 1;
  return { width: l.width / s, height: l.height / s };
}

/**
 * An H.264 layer on the wire with an odd size (outbound-rtp `frameWidth` / `frameHeight`): the
 * hardware encoder refuses it and libwebrtc silently encodes it with OpenH264 (+5 % of a core for
 * a 1080p screen's thumb on M4, docs/14 «Стрим экрана: захват»). Happens when the capture changes
 * its size after `alignCaptureForH264` pinned it: a shared window's content rect settles after the
 * first frames, and a source smaller than the pin is not upscaled to it.
 */
export function hasOddH264Layer(layers: ReadonlyArray<{ codec: string; width: number | null; height: number | null; active?: boolean | null }>): boolean {
  return layers.some((l) => l.codec.toLowerCase() === 'h264' && l.active !== false && ((l.width ?? 0) % 2 === 1 || (l.height ?? 0) % 2 === 1));
}

/**
 * A `scaleResolutionDownBy` for a lower layer that gives even sides on a `width × height` capture,
 * its short side close to `layerShort` (within 8 %); null = none (or no downscale needed).
 * libwebrtc rounds `side / scale` (`encoder_stream_factory.cc`), older code truncated: a side
 * counts as even only when both agree (fraction < 0.5 and an even floor). Fixing the layer's scale
 * instead of re-cropping the capture: a new `exact` constraint on a window capture makes
 * ScreenCaptureKit refit the content and shrink the frame again (seen: 1770 → 1594 → 1464 wide).
 */
export function evenLayerScale(width: number, height: number, layerShort: number): number | null {
  const short = Math.min(width, height);
  if (!(width > 0 && height > 0 && layerShort > 0) || short <= layerShort) return null;
  const even = (v: number): boolean => {
    const f = Math.floor(v);
    return f > 0 && f % 2 === 0 && v - f < 0.5;
  };
  const target = Math.round(layerShort / 2) * 2;
  for (let d = 0; d <= layerShort * 0.08; d += 2) {
    for (const t of d === 0 ? [target] : [target - d, target + d]) {
      if (t <= 0 || t >= short) continue;
      const scale = short / t;
      if (even(width / scale) && even(height / scale)) return scale;
    }
  }
  return null;
}
