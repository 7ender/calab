import { describe, expect, it } from 'vitest';
import { ScreenSharePreset } from './gen/calaba/v1/media_pb.js';
import { SCREEN_SHARE_PRESETS, clampStreamPreset } from './media.js';

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
