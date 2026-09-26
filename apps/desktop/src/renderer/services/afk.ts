import { PresenceStatus } from '@calaba/protocol';
import { log } from '../lib/log';
import { platform } from '../platform';
import { prefs, usePrefs } from '../stores/prefs';
import { useSession } from '../stores/session';
import { setPresence } from './gateway';

/**
 * AFK presence (docs/09 #34): no keyboard/mouse input for N minutes → this session reports
 * `idle`; any input → back to the chosen status. Only an automatic «online» is touched: a
 * manual idle/dnd/invisible is never overridden (the server also ranks manual statuses above
 * an automatic idle from another device). Voice/audio is not affected.
 */

/** Pure decision: which status to send now, or null to leave things as they are. */
export function afkDecision(a: { idleSec: number; thresholdMin: number; manual: PresenceStatus; away: boolean }): 'away' | 'back' | null {
  const eligible = a.manual === PresenceStatus.ONLINE && a.thresholdMin > 0;
  const idle = eligible && a.idleSec >= a.thresholdMin * 60;
  if (idle && !a.away) return 'away';
  if (!idle && a.away) return 'back';
  return null;
}

let away = false;
let timer: number | null = null;

/** Status this session should report (used after a gateway (re)connect). */
export function effectivePresence(): PresenceStatus {
  return away ? PresenceStatus.IDLE : prefs().presence;
}

async function check(): Promise<void> {
  let idleSec: number;
  try {
    idleSec = await platform.system.idleSeconds();
  } catch (e) {
    log.warn('idle time unavailable', e);
    return;
  }
  const p = prefs();
  const d = afkDecision({ idleSec, thresholdMin: p.afkMinutes, manual: p.presence, away });
  if (!d) return;
  away = d === 'away';
  if (useSession.getState().gateway === 'ready') setPresence(away ? PresenceStatus.IDLE : p.presence);
  schedule();
}

/** Poll slowly while active, quickly while away (so returning flips back within ~2 s). */
function schedule(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void check().finally(() => {
      if (timer === null) schedule();
    });
  }, away ? 2000 : 15000);
}

export function installAfk(): () => void {
  schedule();
  // A manual status change or threshold change re-evaluates at once.
  const unsub = usePrefs.subscribe((s, prev) => {
    if (s.presence === prev.presence && s.afkMinutes === prev.afkMinutes) return;
    if (away && s.presence !== PresenceStatus.ONLINE) away = false; // the UI already sent the manual choice
    if (away && s.afkMinutes === 0) {
      away = false;
      setPresence(s.presence);
    }
    void check();
  });
  return () => {
    unsub();
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    away = false;
  };
}
