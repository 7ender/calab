import { describe, expect, it } from 'vitest';
import { loopbackDevice, MAC_SYSTEM_AUDIO_FEATURES, macHasProcessTaps, systemAudioSupport } from './systemAudio';

describe('loopbackDevice', () => {
  it('never mutes local playback: plain loopback on every platform (docs/09 #68)', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) expect(loopbackDevice(p)).toBe('loopback');
  });
});

describe('systemAudioSupport', () => {
  it('Windows: supported (process loopback excludes our sound)', () => {
    expect(systemAudioSupport('win32', '', {})).toBe('supported');
  });

  it('macOS 14.2+: supported (Core Audio tap excludes our sound); older: experimental', () => {
    expect(systemAudioSupport('darwin', '27.0.0', {})).toBe('supported');
    expect(systemAudioSupport('darwin', '14.2.1', {})).toBe('supported');
    expect(systemAudioSupport('darwin', '14.1', {})).toBe('experimental');
    expect(systemAudioSupport('darwin', '13.6.4', {})).toBe('experimental');
  });

  it('macOS kill switch and Linux: unsupported', () => {
    expect(systemAudioSupport('darwin', '27.0.0', { CALABA_MAC_SYSTEM_AUDIO: '0' })).toBe('unsupported');
    expect(systemAudioSupport('linux', '', {})).toBe('unsupported');
  });
});

describe('macHasProcessTaps', () => {
  it('parses short or empty versions safely', () => {
    expect(macHasProcessTaps('15')).toBe(true);
    expect(macHasProcessTaps('')).toBe(false);
  });
});

describe('MAC_SYSTEM_AUDIO_FEATURES', () => {
  it('pins the Core Audio tap path (the SCK flag names do not exist in Chromium 152)', () => {
    expect(MAC_SYSTEM_AUDIO_FEATURES).toEqual(['MacCatapLoopbackAudioForScreenShare']);
  });
});
