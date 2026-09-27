import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { PresenceSchema, PresenceStatus } from '@calaba/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
const sent: PresenceStatus[] = [];
const sentUntil: Array<number | undefined> = [];
vi.mock('./gateway', () => ({
  setPresence: (s: PresenceStatus, until?: number) => {
    sent.push(s);
    sentUntil.push(until);
  },
}));
const listeners = new Map<string, () => void>();
vi.stubGlobal('window', {
  localStorage: globalThis.localStorage,
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  addEventListener: (k: string, fn: () => void) => void listeners.set(k, fn),
  removeEventListener: (k: string) => void listeners.delete(k),
});

const { PRESENCE_DURATIONS, applyServerPresence, choosePresence, clearAfterSeconds, fromServer, installPresenceTimer, nextCheckMs, presenceExpired, presencePatch } =
  await import('./presenceTimer');
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
    sentUntil.length = 0;
    useSession.setState({ gateway: 'ready' } as never);
    usePrefs.getState().setPrefs({ presence: PresenceStatus.ONLINE, presenceUntil: null, presenceSynced: true });
  });
  afterEach(() => vi.useRealTimers());

  it('«Не беспокоить» for 15 minutes: the end goes to the server; the display resets at the end', () => {
    const stop = installPresenceTimer();
    choosePresence(PresenceStatus.DND, 15 * 60_000);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.DND);
    expect(sent).toEqual([PresenceStatus.DND]);
    expect(sentUntil).toEqual([1_000_000 + 15 * 60_000]);
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.DND);
    vi.advanceTimersByTime(1);
    expect(usePrefs.getState().presence).toBe(PresenceStatus.ONLINE);
    expect(usePrefs.getState().presenceUntil).toBeNull();
    expect(sent).toEqual([PresenceStatus.DND]); // the server ends it itself (sweeper)
    stop();
  });

  it('«Навсегда» is sent with until 0, «В сети» clears', () => {
    choosePresence(PresenceStatus.INVISIBLE, null);
    choosePresence(PresenceStatus.ONLINE);
    expect(sent).toEqual([PresenceStatus.INVISIBLE, PresenceStatus.ONLINE]);
    expect(sentUntil).toEqual([0, 0]);
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

describe('status from the server (READY / USER_UPDATE, docs/05)', () => {
  const pres = (status: PresenceStatus, until?: number) =>
    create(PresenceSchema, { status, until: until === undefined ? undefined : timestampFromMs(until) });

  beforeEach(() => {
    sent.length = 0;
    sentUntil.length = 0;
    useSession.setState({ gateway: 'ready' } as never);
    usePrefs.getState().setPrefs({ presence: PresenceStatus.ONLINE, presenceUntil: null, presenceSynced: true });
  });

  it('maps the manual status; none / online = «В сети»', () => {
    expect(fromServer(undefined)).toEqual({ presence: PresenceStatus.ONLINE, presenceUntil: null });
    expect(fromServer(pres(PresenceStatus.DND, 5_000))).toEqual({ presence: PresenceStatus.DND, presenceUntil: 5_000 });
    expect(fromServer(pres(PresenceStatus.INVISIBLE))).toEqual({ presence: PresenceStatus.INVISIBLE, presenceUntil: null });
    expect(fromServer(pres(PresenceStatus.OFFLINE))).toEqual({ presence: PresenceStatus.ONLINE, presenceUntil: null });
  });

  it('READY brings the status chosen on another device, with its end', () => {
    applyServerPresence(pres(PresenceStatus.DND, 9_000_000), true);
    expect(usePrefs.getState()).toMatchObject({ presence: PresenceStatus.DND, presenceUntil: 9_000_000 });
    applyServerPresence(undefined, true); // ended meanwhile
    expect(usePrefs.getState()).toMatchObject({ presence: PresenceStatus.ONLINE, presenceUntil: null });
    expect(sent).toEqual([]);
  });

  it('USER_UPDATE (sweeper) returns to «В сети»', () => {
    applyServerPresence(pres(PresenceStatus.IDLE, 9_000_000), false);
    applyServerPresence(pres(PresenceStatus.ONLINE), false);
    expect(usePrefs.getState()).toMatchObject({ presence: PresenceStatus.ONLINE, presenceUntil: null });
  });

  it('a choice made offline is sent on READY instead of taking the server one', () => {
    useSession.setState({ gateway: 'connecting' } as never);
    choosePresence(PresenceStatus.IDLE, 60_000);
    expect(sent).toEqual([]);
    applyServerPresence(pres(PresenceStatus.DND), true);
    expect(sent).toEqual([PresenceStatus.IDLE]);
    expect(usePrefs.getState()).toMatchObject({ presence: PresenceStatus.IDLE, presenceSynced: true });
    applyServerPresence(pres(PresenceStatus.DND), true); // the next READY: the server wins again
    expect(usePrefs.getState().presence).toBe(PresenceStatus.DND);
  });
});
