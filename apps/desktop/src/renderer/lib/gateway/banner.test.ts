import { describe, expect, it } from 'vitest';
import { ReconnectBanner, RECONNECT_BANNER_DELAY_MS, type BannerTimers } from './banner';

/** Manual clock: timers fire only on advance(); clearTimeout can be made to «lose the race». */
class FakeTimers implements BannerTimers {
  now = 0;
  private seq = 0;
  private pending = new Map<number, { at: number; fn: () => void }>();
  ignoreClear = false;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(h: unknown): void {
    if (!this.ignoreClear) this.pending.delete(h as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at > this.now) continue;
      this.pending.delete(id);
      t.fn();
    }
  }
}

function make() {
  const timers = new FakeTimers();
  const changes: boolean[] = [];
  const b = new ReconnectBanner((v) => changes.push(v), timers);
  return { b, timers, changes };
}

describe('ReconnectBanner', () => {
  it('never shows before the first READY (the spinner covers the first connect)', () => {
    const { b, timers } = make();
    b.update('connecting');
    timers.advance(60_000);
    b.update('reconnecting');
    timers.advance(60_000);
    expect(b.shown).toBe(false);
  });

  it('a drop shorter than 3 s is not shown', () => {
    const { b, timers, changes } = make();
    b.update('ready');
    b.update('reconnecting');
    timers.advance(RECONNECT_BANNER_DELAY_MS - 1);
    b.update('resuming');
    timers.advance(0);
    b.update('ready');
    timers.advance(10_000);
    expect(changes).toEqual([]);
  });

  it('shown after 3 s down; intermediate transitions do not restart the clock', () => {
    const { b, timers } = make();
    b.update('ready');
    b.update('reconnecting');
    timers.advance(2_000);
    b.update('resuming');
    b.update('reconnecting');
    timers.advance(RECONNECT_BANNER_DELAY_MS - 2_000);
    expect(b.shown).toBe(true);
  });

  it('removed at once on READY / RESUMED (status ready)', () => {
    const { b, timers, changes } = make();
    b.update('ready');
    b.update('resuming');
    timers.advance(RECONNECT_BANNER_DELAY_MS);
    expect(b.shown).toBe(true);
    b.update('ready');
    expect(b.shown).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('deploy path: reconnecting → resuming → connecting (INVALID_SESSION) → ready', () => {
    const { b, timers } = make();
    b.update('ready');
    b.update('reconnecting'); // RECONNECT
    b.update('resuming'); // new socket, RESUME
    timers.advance(1_000);
    b.update('connecting'); // INVALID_SESSION → IDENTIFY
    timers.advance(2_500);
    expect(b.shown).toBe(true);
    b.update('ready'); // READY
    expect(b.shown).toBe(false);
    timers.advance(60_000);
    expect(b.shown).toBe(false);
  });

  it('a stale timer from an earlier outage never shows it', () => {
    const { b, timers } = make();
    timers.ignoreClear = true; // the old timer fires anyway (clear raced with it)
    b.update('ready');
    b.update('reconnecting'); // outage 1: timer due at 3000
    timers.advance(2_900);
    b.update('ready'); // outage 1 over
    timers.advance(50);
    b.update('reconnecting'); // outage 2 starts at 2950: due at 5950
    timers.advance(100); // 3050: outage-1 timer fires
    expect(b.shown).toBe(false);
    timers.advance(RECONNECT_BANNER_DELAY_MS);
    expect(b.shown).toBe(true); // outage 2 has really lasted 3 s
  });

  it('stopped / idle (logout, fatal) hides it and forgets the READY', () => {
    const { b, timers } = make();
    b.update('ready');
    b.update('reconnecting');
    timers.advance(RECONNECT_BANNER_DELAY_MS);
    b.update('stopped');
    expect(b.shown).toBe(false);
    b.update('connecting');
    timers.advance(60_000);
    expect(b.shown).toBe(false);
  });

  it('reset() clears a pending timer', () => {
    const { b, timers } = make();
    b.update('ready');
    b.update('reconnecting');
    b.reset();
    timers.advance(60_000);
    expect(b.shown).toBe(false);
  });
});
