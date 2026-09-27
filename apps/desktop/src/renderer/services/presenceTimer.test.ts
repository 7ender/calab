import { PresenceStatus } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
const sent: PresenceStatus[] = [];
vi.mock('./gateway', () => ({ setPresence: (s: PresenceStatus) => void sent.push(s) }));
const listeners = new Map<string, () => void>();
vi.stubGlobal('window', {
  localStorage: globalThis.localStorage,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  addEventListener: (k: string, fn: () => void) => void listeners.set(k, fn),
  removeEventListener: (k: string) => void listeners.delete(k),
});

const { PRESENCE_DURATIONS, choosePresence, clearAfterSeconds, installPresenceTimer, nextCheckMs, presenceExpired, presencePatch } = await import('./presenceTimer');
const { usePrefs } = await import('../stores/prefs');
const { useSession } = await import('../stores/session');

const H = 3_600_000;

describe('status durations (docs/09 #29)', () => {
  it('menu offers 15 min · 1 h · 8 h · 24 h · 3 days · forever', () => {
    expect(PRESENCE_DURATIONS.map((d) => d.ms)).toEqual([15 * 60_000, H, 8 * H, 24 * H, 72 * H, null]);
  });

  it('a timed status ends at now + duration; «online» and «forever» never end', () => {
    expect(presencePatch(PresenceStatus.DND, H, 1000)).toEqual({ presence: PresenceStatus.DND, presenceUntil: 1000 + H });
    expect(presencePatch(PresenceStatus.IDLE, null, 1000).presenceUntil).toBeNull();
    expect(presencePatch(PresenceStatus.ONLINE, H, 1000).presenceUntil).toBeNull();
  });

  it('expires only a non-online status whose end has passed', () => {
    expect(presenceExpired({ presence: PresenceStatus.DND, presenceUntil: 5000 }, 4999)).toBe(false);
    expect(presenceExpired({ presence: PresenceStatus.DND, presenceUntil: 5000 }, 5000)).toBe(true);
    expect(presenceExpired({ presence: PresenceStatus.INVISIBLE, presenceUntil: null }, 9e12)).toBe(false);
    expect(presenceExpired({ presence: PresenceStatus.ONLINE, presenceUntil: 5000 }, 9e12)).toBe(false);
  });

  it('re-checks at the end, but at least every minute (sleep, clock changes)', () => {
    expect(nextCheckMs(null, 0)).toBeNull();
    expect(nextCheckMs(10_000, 0)).toBe(10_000);
    expect(nextCheckMs(8 * H, 0)).toBe(60_000);
    expect(nextCheckMs(0, 5)).toBe(0);
  });
});

describe('custom status «Очистить через»', () => {
  it('fixed spans and «today» = until the local midnight', () => {
    const now = new Date(2026, 8, 27, 22, 30, 0);
    expect(clearAfterSeconds('never', now)).toBe(0);
    expect(clearAfterSeconds('30m', now)).toBe(1800);
    expect(clearAfterSeconds('4h', now)).toBe(14_400);
    expect(clearAfterSeconds('today', now)).toBe(5400);
  });
});

describe('installPresenceTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    sent.length = 0;
    useSession.setState({ gateway: 'ready' } as never);
  });
  afterEach(() => vi.useRealTimers());

  it('«Не беспокоить» for 15 minutes goes back to «В сети» when the time is up', () => {
    const stop = installPresenceTimer();
    choosePresence(PresenceStatus.DND, 15 * 60_000);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.DND);
    expect(sent).toEqual([PresenceStatus.DND]);
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.DND);
    vi.advanceTimersByTime(1);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.ONLINE);
    expect(usePrefs.getState().presenceUntil).toBeNull();
    expect(sent).toEqual([PresenceStatus.DND, PresenceStatus.ONLINE]);
    stop();
  });

  it('a status that ended while the app was closed is reset at startup', () => {
    usePrefs.getState().setPrefs({ presence: PresenceStatus.IDLE, presenceUntil: 999_000 });
    const stop = installPresenceTimer();
    expect(usePrefs.getState().presence).toBe(PresenceStatus.ONLINE);
    stop();
  });

  it('«Навсегда» stays', () => {
    const stop = installPresenceTimer();
    choosePresence(PresenceStatus.INVISIBLE, null);
    vi.advanceTimersByTime(80 * H);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.INVISIBLE);
    stop();
  });
});
