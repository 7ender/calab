import { describe, expect, it } from 'vitest';
import { ScreenSharePreset } from './gen/calaba/v1/media_pb.js';
import { AUDIO_TIERS_KBPS, SCREEN_SHARE_PRESETS, audioTierKbps, clampStreamPreset } from './media.js';

describe('clampStreamPreset', () => {
  it('keeps presets at or below the max', () => {
    expect(clampStreamPreset(ScreenSharePreset.H720, ScreenSharePreset.H1080)).toBe(ScreenSharePreset.H720);
    expect(clampStreamPreset(ScreenSharePreset.ORIGINAL, ScreenSharePreset.H720)).toBe(ScreenSharePreset.H720);
    expect(clampStreamPreset(ScreenSharePreset.UNSPECIFIED, ScreenSharePreset.ORIGINAL)).toBe(ScreenSharePreset.H1080);
  });
  it('has a config for every concrete preset', () => {
    expect(Object.keys(SCREEN_SHARE_PRESETS)).toHaveLength(4);
  });
});

describe('audioTierKbps', () => {
  it('keeps a tier, maps legacy 24 / 48 to the nearest one (a tie goes up)', () => {
    for (const t of AUDIO_TIERS_KBPS) expect(audioTierKbps(t)).toBe(t);
    expect(audioTierKbps(24)).toBe(32);
    expect(audioTierKbps(48)).toBe(64);
    expect(audioTierKbps(12)).toBe(16);
    expect(audioTierKbps(510)).toBe(64);
  });

  it('falls back to the default for nothing / nonsense', () => {
    expect(audioTierKbps(0)).toBe(32);
    expect(audioTierKbps(Number.NaN)).toBe(32);
  });
});
