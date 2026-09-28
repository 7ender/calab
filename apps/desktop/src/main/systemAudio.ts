/**
 * System audio of a screen share (docs/02-media.md, echo rule 4). Pure: no Electron imports, unit-tested.
 *
 * Measured 2026-09-28 on macOS 27 / Electron 44.4.5 (Chromium 152), 1 kHz tone, level in the
 * captured loopback track (AnalyserNode, 1 kHz band; silence ≈ −80 dB):
 *  - `audio: 'loopback'` + `restrictOwnAudio: true` → Chromium opens `loopbackWithoutChrome`
 *    (a Core Audio process tap that excludes the audio-service process): our `<audio>` tone
 *    −65…−69 dB (excluded), the same tone from `afplay` −33 dB (captured).
 *  - `audio: 'loopbackWithMute'` ignores `restrictOwnAudio` (the device stays `loopbackWithMute`):
 *    our tone −32 dB (captured → participants hear themselves) AND the tap is created with
 *    `CATapMuted`, i.e. all local playback is muted while sharing — the presenter hears nobody
 *    (docs/09 #68). On Windows the same device id mutes the whole output endpoint
 *    (`IAudioEndpointVolume::SetMute`), so it is wrong there too.
 *  - `restrictOwnAudio` maps to process-loopback exclusion on Windows as well
 *    (`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`, Windows 10 2004+).
 */

/** The loopback device we ask Electron for. Never `loopbackWithMute`: it mutes local playback and defeats `restrictOwnAudio`. */
export function loopbackDevice(_platform: NodeJS.Platform): 'loopback' {
  return 'loopback';
}

/**
 * Chromium features for macOS system audio. `MacCatapLoopbackAudioForScreenShare` (Core Audio
 * tap, macOS 14.2+) is on by default in Chromium 152; pinned so a default flip cannot silently
 * fall back to the ScreenCaptureKit path, which does not exclude our own sound (measured: with it
 * disabled the track reports `restrictOwnAudio: false` and our tone comes through at −32 dB).
 * The old names `MacLoopbackAudioForScreenShare` / `MacSckSystemAudioLoopbackOverride` do not
 * exist in this build.
 */
export const MAC_SYSTEM_AUDIO_FEATURES = ['MacCatapLoopbackAudioForScreenShare'];

/** Core Audio process taps (and thus exclusion of our own sound) need macOS 14.2+. */
export function macHasProcessTaps(macosVersion: string): boolean {
  const [major = 0, minor = 0] = macosVersion.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2);
}

export type SystemAudioSupport = 'supported' | 'experimental' | 'unsupported';

/**
 * 'supported' — our own playback (participants' voices) is excluded from the capture; the picker
 * turns system audio on by default. 'experimental' — capture works but may include our sound: off
 * by default, the picker warns. `CALABA_MAC_SYSTEM_AUDIO=0` turns it off on macOS.
 */
export function systemAudioSupport(platform: NodeJS.Platform, macosVersion: string, env: Record<string, string | undefined>): SystemAudioSupport {
  if (platform === 'win32') return 'supported';
  if (platform !== 'darwin' || env['CALABA_MAC_SYSTEM_AUDIO'] === '0') return 'unsupported';
  return macHasProcessTaps(macosVersion) ? 'supported' : 'experimental';
}
