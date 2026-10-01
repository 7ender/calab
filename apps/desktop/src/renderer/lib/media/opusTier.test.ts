import { describe, expect, it } from 'vitest';
import { micTier, mungeOpusAnswer, musicTier, opusFmtp } from './opusTier';

/** A LiveKit answer: the mic (mid 0), a screen-share audio (mid 2), a video between them. */
const ANSWER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 maxaveragebitrate=510000;minptime=10;stereo=1;usedtx=1;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:2',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 maxaveragebitrate=510000;minptime=10;stereo=1;useinbandfec=1',
  '',
].join('\r\n');

describe('micTier', () => {
  it('maps the room setting to its tier, capped by the personal limit', () => {
    const voice = { dtx: true, stereo: false };
    expect(micTier(8, null)).toEqual({ kbps: 8, maxPlaybackRate: 8000, fec: false, ...voice });
    expect(micTier(16, null)).toEqual({ kbps: 16, maxPlaybackRate: 16000, fec: false, ...voice });
    expect(micTier(32, null)).toEqual({ kbps: 32, maxPlaybackRate: 24000, fec: true, ...voice });
    expect(micTier(64, null)).toEqual({ kbps: 64, maxPlaybackRate: 48000, fec: true, ...voice });
    expect(micTier(64, 16).kbps).toBe(16);
    expect(micTier(8, 64).kbps).toBe(8); // the cap never raises
  });

  it('maps legacy 24 / 48 to the nearest tier (a tie goes up); nonsense to the default', () => {
    expect(micTier(24, null).kbps).toBe(32);
    expect(micTier(48, null).kbps).toBe(64);
    expect(micTier(0, null).kbps).toBe(32);
    expect(micTier(64, 48).kbps).toBe(64);
  });
});

describe('musicTier (ADR-0052)', () => {
  it('ignores the room tier: 128 kbps for a mono source, 192 for a stereo one', () => {
    expect(musicTier(1, undefined)).toEqual({ kbps: 128, maxPlaybackRate: 48000, fec: true, dtx: false, stereo: true });
    expect(musicTier(2, 0)).toEqual({ kbps: 192, maxPlaybackRate: 48000, fec: true, dtx: false, stereo: true });
  });

  it('is capped by a plan that limits voice quality: that tier, mono, still without DTX', () => {
    expect(musicTier(2, 16)).toEqual({ kbps: 16, maxPlaybackRate: 16000, fec: false, dtx: false, stereo: false });
    expect(musicTier(1, 64)).toEqual({ kbps: 64, maxPlaybackRate: 48000, fec: true, dtx: false, stereo: false });
    // A plan cap at or above the profile does not limit it.
    expect(musicTier(1, 128).kbps).toBe(128);
  });
});

describe('opusFmtp', () => {
  it('replaces the owned params, drops stereo, keeps the rest in order', () => {
    expect(opusFmtp('maxaveragebitrate=510000;minptime=10;stereo=1;usedtx=1;useinbandfec=1', micTier(16, null))).toBe(
      'minptime=10;maxplaybackrate=16000;maxaveragebitrate=16000;useinbandfec=0;usedtx=1',
    );
    expect(opusFmtp('', micTier(64, null))).toBe('maxplaybackrate=48000;maxaveragebitrate=64000;useinbandfec=1;usedtx=1');
  });

  it('writes the musician profile: fullband, FEC, no DTX, stereo encoder', () => {
    expect(opusFmtp('maxaveragebitrate=510000;minptime=10;stereo=1;usedtx=1;useinbandfec=1', musicTier(1, undefined))).toBe(
      'minptime=10;maxplaybackrate=48000;maxaveragebitrate=128000;useinbandfec=1;usedtx=0;stereo=1',
    );
    // Back to a voice tier from a musician answer: DTX on again, stereo gone.
    expect(opusFmtp('minptime=10;maxplaybackrate=48000;maxaveragebitrate=128000;useinbandfec=1;usedtx=0;stereo=1', micTier(32, null))).toBe(
      'minptime=10;maxplaybackrate=24000;maxaveragebitrate=32000;useinbandfec=1;usedtx=1',
    );
  });
});

describe('mungeOpusAnswer', () => {
  it('rewrites only the Opus fmtp of the given m-section', () => {
    const out = mungeOpusAnswer(ANSWER, '0', micTier(8, null));
    const diff = out.split('\r\n').filter((l, i) => l !== ANSWER.split('\r\n')[i]);
    expect(diff).toEqual(['a=fmtp:111 minptime=10;maxplaybackrate=8000;maxaveragebitrate=8000;useinbandfec=0;usedtx=1']);
    // The screen-share audio (same payload type, another section) keeps LiveKit's values.
    expect(out).toContain('a=fmtp:111 maxaveragebitrate=510000;minptime=10;stereo=1;useinbandfec=1');
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('adds an fmtp line when the section has none', () => {
    const noFmtp = ANSWER.replace('a=fmtp:111 maxaveragebitrate=510000;minptime=10;stereo=1;usedtx=1;useinbandfec=1\r\n', '');
    const out = mungeOpusAnswer(noFmtp, '0', micTier(32, null));
    expect(out).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxplaybackrate=24000;maxaveragebitrate=32000;useinbandfec=1;usedtx=1\r\n');
  });

  it('leaves the SDP alone for an unknown mid, a video mid or a section without Opus', () => {
    expect(mungeOpusAnswer(ANSWER, '7', micTier(8, null))).toBe(ANSWER);
    expect(mungeOpusAnswer(ANSWER, '1', micTier(8, null))).toBe(ANSWER);
    const pcmu = ANSWER.replace(/opus\/48000\/2/g, 'PCMU/8000');
    expect(mungeOpusAnswer(pcmu, '0', micTier(8, null))).toBe(pcmu);
  });

  it('is idempotent (a renegotiation re-munges the same answer)', () => {
    const once = mungeOpusAnswer(ANSWER, '0', micTier(16, null));
    expect(mungeOpusAnswer(once, '0', micTier(16, null))).toBe(once);
  });

  it('keeps LF-only SDP as LF', () => {
    const lf = ANSWER.replace(/\r\n/g, '\n');
    expect(mungeOpusAnswer(lf, '0', micTier(64, null))).not.toContain('\r');
  });
});
