import { describe, expect, it } from 'vitest';
import { loopbackDevice, MAC_SYSTEM_AUDIO_FEATURES, macHasProcessTaps, systemAudioSupport, winHasProcessLoopback } from './systemAudio';

describe('loopbackDevice', () => {
  it('never mutes local playback: plain loopback on every platform (docs/09 #68)', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) expect(loopbackDevice(p)).toBe('loopback');
  });
});

describe('systemAudioSupport', () => {
  it('Windows 11: supported (process loopback excludes our sound); Windows 10: experimental (docs/09 #122)', () => {
    expect(systemAudioSupport('win32', '10.0.22000', {})).toBe('supported');
    expect(systemAudioSupport('win32', '10.0.26100', {})).toBe('supported');
    // Chromium 152 drops `restrictOwnAudio` below WIN11: endpoint loopback carries the voices.
    expect(systemAudioSupport('win32', '10.0.19045', {})).toBe('experimental');
    expect(systemAudioSupport('win32', '', {})).toBe('experimental');
    // The macOS kill switch does not apply to Windows.
    expect(systemAudioSupport('win32', '10.0.22631', { CALABA_MAC_SYSTEM_AUDIO: '0' })).toBe('supported');
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

describe('winHasProcessLoopback', () => {
  it('Windows 11 = build 22000+ (base::win::Version::WIN11)', () => {
    expect(winHasProcessLoopback('10.0.21999')).toBe(false);
    expect(winHasProcessLoopback('10.0.22000')).toBe(true);
    expect(winHasProcessLoopback('11.0.0')).toBe(true);
    expect(winHasProcessLoopback('10.0')).toBe(false);
    expect(winHasProcessLoopback('')).toBe(false);
  });
});

describe('MAC_SYSTEM_AUDIO_FEATURES', () => {
  it('pins the Core Audio tap path (the SCK flag names do not exist in Chromium 152)', () => {
    expect(MAC_SYSTEM_AUDIO_FEATURES).toEqual(['MacCatapLoopbackAudioForScreenShare']);
  });
});
