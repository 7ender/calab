import { describe, expect, it } from 'vitest';
import { qualityOf, toggleDeafen, toggleMute, transmitDecision } from './voiceLogic';

describe('mute / deafen', () => {
  it('mute toggles; unmute while deafened also undeafens', () => {
    expect(toggleMute({ muted: false, deafened: false })).toEqual({ muted: true, deafened: false });
    expect(toggleMute({ muted: true, deafened: false })).toEqual({ muted: false, deafened: false });
    expect(toggleMute({ muted: true, deafened: true })).toEqual({ muted: false, deafened: false });
  });
  it('deafen implies mute and restores both', () => {
    expect(toggleDeafen({ muted: false, deafened: false })).toEqual({ muted: true, deafened: true });
    expect(toggleDeafen({ muted: true, deafened: true })).toEqual({ muted: false, deafened: false });
  });
});

describe('transmitDecision', () => {
  const base = { muted: false, deafened: false, canSpeak: true, mode: 'voice' as const, gateOpen: false, pttDown: false };

  it('VAD gate closed: audio off but NOT a LiveKit mute (no signalling on pauses)', () => {
    expect(transmitDecision(base)).toEqual({ livekitMuted: false, audioEnabled: false, transmitting: false });
    expect(transmitDecision({ ...base, gateOpen: true })).toEqual({ livekitMuted: false, audioEnabled: true, transmitting: true });
  });

  it('PTT follows the key, ignores the gate', () => {
    expect(transmitDecision({ ...base, mode: 'ptt', gateOpen: true }).transmitting).toBe(false);
    expect(transmitDecision({ ...base, mode: 'ptt', pttDown: true }).transmitting).toBe(true);
  });

  it('explicit mute / deafen / no SPEAK are LiveKit mutes', () => {
    for (const s of [{ muted: true }, { deafened: true }, { canSpeak: false }]) {
      const d = transmitDecision({ ...base, gateOpen: true, ...s });
      expect(d.livekitMuted).toBe(true);
      expect(d.transmitting).toBe(false);
    }
  });
});

describe('qualityOf', () => {
  it('classifies RTT/loss', () => {
    expect(qualityOf(null, null)).toBe('unknown');
    expect(qualityOf(40, 0)).toBe('good');
    expect(qualityOf(200, 1)).toBe('fair');
    expect(qualityOf(80, 5)).toBe('fair');
    expect(qualityOf(400, 0)).toBe('poor');
    expect(qualityOf(50, 12)).toBe('poor');
  });
});
