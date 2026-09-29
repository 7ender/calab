import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: {} }));
import { ownAudioExcluded, systemAudioConstraints } from './screenShare';

describe('systemAudioConstraints (docs/02 echo rule 4, docs/09 #68, #122)', () => {
  it('asks Chromium to exclude our own playback and never mutes local playback (macOS and Windows alike)', () => {
    const c = systemAudioConstraints();
    // With main's plain 'loopback' this becomes `loopbackWithoutChrome`: Core Audio tap (macOS
    // 14.2+) / WASAPI process loopback EXCLUDE_TARGET_PROCESS_TREE (Windows 11).
    expect(c.restrictOwnAudio).toBe(true);
    expect(c.suppressLocalAudioPlayback).toBe(false);
  });

  it('turns voice processing off (music/game sound, not a mic)', () => {
    expect(systemAudioConstraints()).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
  });
});

describe('ownAudioExcluded', () => {
  it('true when Chromium reports the constraint or the process-loopback device', () => {
    expect(ownAudioExcluded({ restrictOwnAudio: true })).toBe(true);
    expect(ownAudioExcluded({ deviceId: 'loopbackWithoutChrome' })).toBe(true);
  });

  it('false for plain endpoint loopback (Windows 10, macOS < 14.2: participants would hear themselves)', () => {
    expect(ownAudioExcluded({ restrictOwnAudio: false, deviceId: 'loopback' })).toBe(false);
    expect(ownAudioExcluded({ deviceId: 'loopbackWithMute' })).toBe(false);
  });
});
