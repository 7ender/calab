import { audioTierKbps, type AudioTierKbps } from '@calaba/protocol';

/**
 * Voice quality tiers on the wire (docs/02 «Битрейт»).
 *
 * `RTCRtpEncodingParameters.maxBitrate` alone does reach the Opus encoder, but libopus picks the
 * audio bandwidth from the bitrate by itself and goes fullband from ~14 kbps: 16, 32 and 64 kbps
 * all sounded «the same» (owner, 28.09). The audible difference is the bandwidth, so every tier
 * also caps it. libwebrtc configures the send encoder from the *remote* description of the send
 * codec (the SFU's answer): `maxplaybackrate` → OPUS_SET_MAX_BANDWIDTH, `maxaveragebitrate` →
 * the start bitrate, `useinbandfec` → LBRR. `setCodecPreferences` cannot carry fmtp, so the
 * answer is munged for the microphone's m-section only (the other tracks keep LiveKit's values).
 */
export interface OpusTier {
  /** Bitrate: a voice tier (8–64) or the musician profile (128 / 192, ADR-0052). */
  kbps: number;
  /** `maxplaybackrate` (Hz): 8000 NB (telephone), 16000 WB, 24000 SWB, 48000 FB. */
  maxPlaybackRate: number;
  /** In-band FEC: costs bits under loss, only worth it where there are bits to spare. */
  fec: boolean;
  /** Opus DTX (`usedtx`): near-silence costs ~1 kbps. Off for music — quiet notes are not silence. */
  dtx: boolean;
  /**
   * `stereo=1`: libwebrtc's Opus encoder then runs with two channels in the AUDIO application
   * (mono runs VOIP, with a speech high-pass that thins bass). Voice tiers: off (a mono voice).
   */
  stereo: boolean;
}

const TIERS: Record<AudioTierKbps, OpusTier> = {
  8: { kbps: 8, maxPlaybackRate: 8000, fec: false, dtx: true, stereo: false },
  16: { kbps: 16, maxPlaybackRate: 16000, fec: false, dtx: true, stereo: false },
  32: { kbps: 32, maxPlaybackRate: 24000, fec: true, dtx: true, stereo: false },
  64: { kbps: 64, maxPlaybackRate: 48000, fec: true, dtx: true, stereo: false },
};

/** Musician profile bitrates (ADR-0052): a mono source (most mics) and a stereo one (interfaces). */
export const MUSIC_KBPS_MONO = 128;
export const MUSIC_KBPS_STEREO = 192;

/** The tier the mic publishes at: the room setting capped by the personal limit (null = none). */
export function micTier(roomKbps: number, personalKbps: number | null): OpusTier {
  const room = audioTierKbps(roomKbps);
  const cap = personalKbps === null ? room : audioTierKbps(personalKbps);
  return TIERS[Math.min(room, cap) as AudioTierKbps];
}

/**
 * The musician profile (ADR-0052): fullband, FEC, no DTX, the stereo encoder (AUDIO application),
 * 128 kbps for a mono source and 192 for a stereo one. It ignores the room tier and the personal
 * cap (both are about talking); a plan that caps voice quality (`audio_tier_max_kbps`, Free) still
 * caps it — then it is that tier, mono, without DTX.
 */
export function musicTier(sourceChannels: number, planMaxKbps: number | undefined): OpusTier {
  if (planMaxKbps && planMaxKbps < MUSIC_KBPS_MONO) {
    const tier = TIERS[audioTierKbps(Math.min(planMaxKbps, 64))];
    return { ...tier, dtx: false };
  }
  return { kbps: sourceChannels >= 2 ? MUSIC_KBPS_STEREO : MUSIC_KBPS_MONO, maxPlaybackRate: 48000, fec: true, dtx: false, stereo: true };
}

/**
 * Opus fmtp parameters a tier owns; everything else in the line (minptime …) stays.
 * `stereo=1`, which LiveKit's answer carries for every audio section, is dropped for a voice
 * tier: the mic is mono (AUDIO_PUBLISH_DEFAULTS.channels), and a stereo encoder spends a tier's
 * few bits on a second, identical channel. `usedtx` is owned so a live switch between voice and
 * the musician profile does not depend on what the track was published with.
 */
const OWNED = new Set(['maxplaybackrate', 'sprop-maxcapturerate', 'maxaveragebitrate', 'useinbandfec', 'stereo', 'usedtx']);

/** The fmtp config with the tier's parameters in place of any previous ones. */
export function opusFmtp(config: string, tier: OpusTier): string {
  const kept = config
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p !== '' && !OWNED.has(p.split('=')[0]?.toLowerCase() ?? ''));
  kept.push(`maxplaybackrate=${tier.maxPlaybackRate}`, `maxaveragebitrate=${tier.kbps * 1000}`, `useinbandfec=${tier.fec ? 1 : 0}`, `usedtx=${tier.dtx ? 1 : 0}`);
  if (tier.stereo) kept.push('stereo=1');
  return kept.join(';');
}

/**
 * Rewrites the Opus fmtp of the m-section `mid` in `sdp` (an answer to our offer) for `tier`.
 * Anything else — other sections, other codecs of this section — is returned byte for byte.
 */
export function mungeOpusAnswer(sdp: string, mid: string, tier: OpusTier): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  // Section bounds: [start, end) of every m= block.
  const starts = lines.flatMap((l, i) => (l.startsWith('m=') ? [i] : []));
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s] ?? 0;
    const end = starts[s + 1] ?? lines.length;
    const section = lines.slice(start, end);
    if (!section[0]?.startsWith('m=audio') || !section.includes(`a=mid:${mid}`)) continue;
    const pt = section.map((l) => /^a=rtpmap:(\d+) opus\/48000/i.exec(l)?.[1]).find((p) => p !== undefined);
    if (pt === undefined) return sdp;
    const fmtpAt = section.findIndex((l) => l.startsWith(`a=fmtp:${pt} `));
    if (fmtpAt >= 0) {
      section[fmtpAt] = `a=fmtp:${pt} ${opusFmtp(section[fmtpAt]?.slice(`a=fmtp:${pt} `.length) ?? '', tier)}`;
    } else {
      const rtpmapAt = section.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      section.splice(rtpmapAt + 1, 0, `a=fmtp:${pt} ${opusFmtp('', tier)}`);
    }
    return [...lines.slice(0, start), ...section, ...lines.slice(end)].join(eol);
  }
  return sdp;
}
