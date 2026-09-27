import { PresenceStatus } from '@calaba/protocol';
import type { MessageKey } from '../i18n';
import { prefs, usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { setPresence } from './gateway';

/**
 * Status durations of the status menu (docs/09 #29, Discord): «Не активен / Не беспокоить /
 * Невидимый» › 15 минут · 1 час · 8 часов · 24 часа · 3 дня · Навсегда. When the time is up the
 * status goes back to «В сети». Client-side for now (prefs.presenceUntil, per device): the server
 * has no `until` yet — the timer runs while the app does and is re-checked at startup.
 */
export interface PresenceDuration {
  key: MessageKey;
  /** null = «Навсегда». */
  ms: number | null;
}

const MIN = 60_000;
export const PRESENCE_DURATIONS: readonly PresenceDuration[] = [
  { key: 'presence.for15m', ms: 15 * MIN },
  { key: 'presence.for1h', ms: 60 * MIN },
  { key: 'presence.for8h', ms: 8 * 60 * MIN },
  { key: 'presence.for24h', ms: 24 * 60 * MIN },
  { key: 'presence.for3d', ms: 3 * 24 * 60 * MIN },
  { key: 'presence.forever', ms: null },
];

/** «Свой статус» → «Очистить через» (server-side expiry: `expires_in_seconds`, docs/05 «Статус»). */
export type ClearAfter = 'never' | '30m' | '1h' | '4h' | 'today';
export const CLEAR_AFTER: ReadonlyArray<{ value: ClearAfter; key: MessageKey }> = [
  { value: 'never', key: 'presence.clearNever' },
  { value: '30m', key: 'presence.clear30m' },
  { value: '1h', key: 'presence.clear1h' },
  { value: '4h', key: 'presence.clear4h' },
  { value: 'today', key: 'presence.clearToday' },
];

/** Seconds until the custom status clears; 0 = never. «Сегодня» — at the next local midnight. */
export function clearAfterSeconds(v: ClearAfter, now: Date): number {
  switch (v) {
    case 'never':
      return 0;
    case '30m':
      return 30 * 60;
    case '1h':
      return 3600;
    case '4h':
      return 4 * 3600;
    case 'today': {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return Math.max(60, Math.round((midnight.getTime() - now.getTime()) / 1000));
    }
  }
}

/** The prefs patch for a choice: «В сети» and «Навсегда» have no end. */
export function presencePatch(status: PresenceStatus, ms: number | null, now: number): { presence: PresenceStatus; presenceUntil: number | null } {
  return { presence: status, presenceUntil: status === PresenceStatus.ONLINE || ms === null ? null : now + ms };
}

/** The chosen status ran out: time to go back to «В сети». */
export function presenceExpired(p: { presence: PresenceStatus; presenceUntil: number | null }, now: number): boolean {
  return p.presence !== PresenceStatus.ONLINE && p.presenceUntil !== null && now >= p.presenceUntil;
}

/** How long to wait before the next check: to the end, but at most a minute (sleep / clock changes). */
export function nextCheckMs(until: number | null, now: number): number | null {
  if (until === null) return null;
  return Math.max(0, Math.min(until - now, MIN));
}

/** Status menu: set my status (for `ms`, or forever) and tell the gateway. */
export function choosePresence(status: PresenceStatus, ms: number | null = null): void {
  usePrefs.getState().setPrefs(presencePatch(status, ms, Date.now()));
  if (useSession.getState().gateway === 'ready') setPresence(status);
}

let timer: number | null = null;

function check(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  const p = prefs();
  const now = Date.now();
  if (presenceExpired(p, now)) {
    choosePresence(PresenceStatus.ONLINE);
    return; // the prefs subscription re-schedules (nothing to wait for now)
  }
  const wait = p.presence === PresenceStatus.ONLINE ? null : nextCheckMs(p.presenceUntil, now);
  if (wait !== null) timer = window.setTimeout(check, wait);
}

/** AppShell: checks at startup (a status that ended while the app was closed) and on every change. */
export function installPresenceTimer(): () => void {
  check();
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.presence !== prev.presence || s.presenceUntil !== prev.presenceUntil) check();
  });
  const onFocus = (): void => check(); // back from sleep: timers were paused
  window.addEventListener('focus', onFocus);
  return () => {
    unsub();
    window.removeEventListener('focus', onFocus);
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
}
