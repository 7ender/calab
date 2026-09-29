import type { UpdateStatus } from '../../../shared/ipc';
import { isNewerVersion } from '../../../shared/version';

/**
 * The update bar under the title bar (docs/08 «Обновление», docs/09 #125), pure for tests.
 *
 * Shown for: a downloaded update («Перезапустить и обновить»); an available one that will not
 * download by itself (notify-only, or «Автоматически обновлять» off → «Скачать и установить» /
 * «Скачать»); a download the user started (auto-update off, so the bar keeps showing progress);
 * the web client whose bundle is older than the server («Обновить страницу»). A version not
 * newer than the running app is never offered (a stale feed / mirror).
 *
 * Nag cadence: «Позже» hides the bar for LATER_MS (until the next app start at most); after
 * NAG_LATER presses the bar has no «Позже», only «×» hiding it for CLOSE_MS. The count survives
 * restarts and resets when the running version changes (the user did update).
 */

export const LATER_MS = 4 * 60 * 60 * 1000;
export const CLOSE_MS = 24 * 60 * 60 * 1000;
/** «Позже» presses before the bar loses it (3 × 4 h = 12 h of postponing). */
export const NAG_LATER = 3;

/** Persisted in prefs (`updateNag`). */
export interface UpdateNag {
  /** The app version the presses were made on: another one (updated) resets the count. */
  appVersion: string;
  /** «Позже» presses so far. */
  later: number;
  /** Hidden until (epoch ms); 0 = shown. */
  until: number;
  /** Hidden by «×» (lasts across restarts) rather than «Позже» (the next app start shows it again). */
  closed: boolean;
}

export type UpdateBarModel =
  | { kind: 'downloaded'; version: string; afterCall: boolean }
  | { kind: 'available'; version: string; installable: boolean; downloadPage: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'web'; version: string };

export interface UpdateInput {
  update: UpdateStatus;
  /** Web: the server's version when newer than the bundle ('' = none / desktop). */
  webVersion: string;
  /** The running app / bundle version. */
  appVersion: string;
  /** «Автоматически обновлять» (desktop settings; false on the web). */
  autoUpdate: boolean;
}

/** What the bar would show ignoring «Позже» / «×» — also the gear dot and the «Обновление» badge. */
export function pendingUpdate(i: UpdateInput): UpdateBarModel | null {
  const u = i.update;
  const newer = (v: string): boolean => isNewerVersion(v, i.appVersion);
  if (i.webVersion && newer(i.webVersion)) return { kind: 'web', version: i.webVersion };
  if (u.state === 'downloaded') return newer(u.version) ? { kind: 'downloaded', version: u.version, afterCall: u.afterCall === true } : null;
  if (u.state === 'available') {
    if (!newer(u.version)) return null;
    // Auto mode deferred by a call: it downloads by itself when the call ends.
    if (i.autoUpdate && u.installable && !u.downloadPage) return null;
    return { kind: 'available', version: u.version, installable: u.installable === true, downloadPage: u.downloadPage ?? '' };
  }
  // A background download is quiet; one the user asked for (auto-update off) keeps its progress.
  if (u.state === 'downloading' && !i.autoUpdate && newer(u.version)) return { kind: 'downloading', version: u.version, percent: u.percent };
  return null;
}

/** Whether a gear dot / settings badge is due: a primitive for a Zustand selector. */
export function hasPendingUpdate(i: UpdateInput): boolean {
  const p = pendingUpdate(i);
  return p !== null && p.kind !== 'downloading';
}

/** The bar is hidden by «Позже» / «×» at `now` (for this app version). */
export function snoozed(nag: UpdateNag | null, appVersion: string, now: number): boolean {
  return nag !== null && nag.appVersion === appVersion && nag.until > now;
}

/** «Позже» is offered until it was pressed NAG_LATER times on this version. */
export function laterAllowed(nag: UpdateNag | null, appVersion: string): boolean {
  return !nag || nag.appVersion !== appVersion || nag.later < NAG_LATER;
}

/** «Позже» (hide for LATER_MS, count it) or «×» (hide for CLOSE_MS). */
export function snooze(nag: UpdateNag | null, appVersion: string, now: number, how: 'later' | 'close'): UpdateNag {
  const later = nag && nag.appVersion === appVersion ? nag.later : 0;
  return how === 'later'
    ? { appVersion, later: later + 1, until: now + LATER_MS, closed: false }
    : { appVersion, later, until: now + CLOSE_MS, closed: true };
}

/**
 * App start: «Позже» lasts until the next start at most (the bar shows again); «×» keeps its
 * 24 h; another app version (the user updated) forgets everything.
 */
export function nagOnStart(nag: UpdateNag | null, appVersion: string): UpdateNag | null {
  if (!nag || nag.appVersion !== appVersion) return null;
  return nag.closed ? nag : { ...nag, until: 0 };
}
