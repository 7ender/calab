import { describe, expect, it } from 'vitest';
import type { VoicePhase } from '../stores/voice';
import { DisplayedPhase, cspBlockedHost, describeConnectError, hostOfUrl, offerRetry, type PhaseTimers } from './voiceLink';

/** Manual clock for the injected timers. */
function clock(): PhaseTimers & { advance(ms: number): void } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    advance(ms) {
      now += ms;
      for (const [id, tm] of [...timers]) {
        if (tm.at <= now) {
          timers.delete(id);
          tm.fn();
        }
      }
    },
  };
}

function track(initial: VoicePhase = 'connected'): { d: DisplayedPhase; shown: VoicePhase[]; c: ReturnType<typeof clock> } {
  const c = clock();
  const shown: VoicePhase[] = [];
  const d = new DisplayedPhase(initial, (p) => shown.push(p), c);
  return { d, shown, c };
}

describe('DisplayedPhase (voice panel debounce, 0.2.1)', () => {
  it('a reconnect shorter than 1.5 s never reaches the panel', () => {
    const { d, shown, c } = track();
    d.update('reconnecting');
    c.advance(1400);
    d.update('connected');
    c.advance(5000);
    expect(shown).toEqual([]);
    expect(d.phase).toBe('connected');
  });
  it('a held reconnect shows once, however many attempts flip the store', () => {
    const { d, shown, c } = track();
    d.update('reconnecting');
    c.advance(1500);
    expect(shown).toEqual(['reconnecting']);
    for (let i = 0; i < 5; i++) {
      d.update('reconnecting');
      c.advance(1000);
    }
    expect(shown).toEqual(['reconnecting']);
    d.update('connected');
    expect(shown).toEqual(['reconnecting', 'connected']);
  });
  it('repeated reconnecting updates do not restart the 1.5 s clock', () => {
    const { d, shown, c } = track();
    d.update('reconnecting');
    c.advance(1000);
    d.update('reconnecting');
    c.advance(500);
    expect(shown).toEqual(['reconnecting']);
  });
  it('first connect, blocked and leaving are immediate', () => {
    const { d, shown } = track('idle');
    d.update('connecting');
    d.update('reconnecting'); // not from «connected»: nothing to hide
    d.update('blocked');
    d.update('idle');
    expect(shown).toEqual(['connecting', 'reconnecting', 'blocked', 'idle']);
  });
  it('leaving during the grace period cancels the pending display', () => {
    const { d, shown, c } = track();
    d.update('reconnecting');
    d.update('idle');
    c.advance(5000);
    expect(shown).toEqual(['idle']);
  });
  it('delay 0 (visual tests): immediate', () => {
    const shown: VoicePhase[] = [];
    const d = new DisplayedPhase('connected', (p) => shown.push(p), clock(), 0);
    d.update('reconnecting');
    expect(shown).toEqual(['reconnecting']);
  });
});

describe('voice link diagnostics', () => {
  it('describes livekit ConnectionError and plain errors', () => {
    expect(describeConnectError({ name: 'ConnectionError', reasonName: 'NotAllowed', message: 'invalid token', status: 401 })).toBe(
      'ConnectionError / NotAllowed: invalid token, HTTP 401',
    );
    expect(describeConnectError(new Error('boom'))).toBe('boom');
    expect(describeConnectError('x')).toBe('x');
    expect(describeConnectError({})).toBe('unknown error');
  });
  it('CSP reports: connect-src with an absolute URL → host', () => {
    expect(cspBlockedHost({ effectiveDirective: 'connect-src', blockedURI: 'wss://rtc.calab.ru/rtc?access_token=x' })).toBe('rtc.calab.ru');
    expect(cspBlockedHost({ violatedDirective: 'connect-src https://app.calab.ru', blockedURI: 'https://turn.calab.ru/' })).toBe('turn.calab.ru');
    expect(cspBlockedHost({ effectiveDirective: 'img-src', blockedURI: 'https://x.example/a.png' })).toBeNull();
    expect(cspBlockedHost({ effectiveDirective: 'connect-src', blockedURI: 'eval' })).toBeNull();
    expect(hostOfUrl('wss://rtc.calab.ru:7881/rtc')).toBe('rtc.calab.ru:7881');
    expect(hostOfUrl('nope')).toBeNull();
  });
  it('«Повторить» from the 3rd failed attempt, or at once when blocked', () => {
    expect(offerRetry('reconnecting', 2)).toBe(false);
    expect(offerRetry('reconnecting', 3)).toBe(true);
    expect(offerRetry('blocked', 0)).toBe(true);
    expect(offerRetry('connected', 9)).toBe(false);
  });
});
