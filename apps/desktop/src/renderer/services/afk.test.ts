import { PresenceStatus } from '@calaba/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({ platform: { kind: 'web', system: { idleSeconds: () => Promise.resolve(0) } } }));
vi.mock('./gateway', () => ({ setPresence: vi.fn() }));

const { afkDecision } = await import('./afk');

const ON = PresenceStatus.ONLINE;

describe('afkDecision', () => {
  it('goes away after the threshold and comes back on input', () => {
    expect(afkDecision({ idleSec: 599, thresholdMin: 10, manual: ON, away: false })).toBeNull();
    expect(afkDecision({ idleSec: 600, thresholdMin: 10, manual: ON, away: false })).toBe('away');
    expect(afkDecision({ idleSec: 700, thresholdMin: 10, manual: ON, away: true })).toBeNull();
    expect(afkDecision({ idleSec: 1, thresholdMin: 10, manual: ON, away: true })).toBe('back');
  });

  it('never overrides a manual status and respects «off»', () => {
    for (const manual of [PresenceStatus.DND, PresenceStatus.INVISIBLE, PresenceStatus.IDLE]) {
      expect(afkDecision({ idleSec: 99999, thresholdMin: 5, manual, away: false })).toBeNull();
    }
    expect(afkDecision({ idleSec: 99999, thresholdMin: 0, manual: ON, away: false })).toBeNull();
    expect(afkDecision({ idleSec: 99999, thresholdMin: 0, manual: ON, away: true })).toBe('back');
  });
});
