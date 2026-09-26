import type { Me } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { localTimeZone, timeZoneLabel } from '../lib/timezone';
import { useSession } from '../stores/session';
import { useWorkspaces } from '../stores/workspaces';

let synced = false;

/**
 * Once per app session (on READY): tell the server this device's IANA zone when the profile has
 * another one (or none) — others see «(+3 UTC)» next to my name (User.timezone).
 */
export function syncTimeZone(me: Me | null | undefined): void {
  if (synced || !me?.user) return;
  synced = true;
  const tz = localTimeZone();
  if (!tz || me.user.timezone === tz) return;
  void api.me
    .update({ timezone: tz })
    .then((r) => {
      if (r.me) useSession.getState().set({ me: r.me });
    })
    .catch((e: unknown) => log.warn('time zone sync failed', e));
}

/** «(+5 UTC)» for a member whose zone differs from mine right now, else null. */
export function useTimeZoneLabel(userId: string): string | null {
  const theirs = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  return timeZoneLabel(theirs, localTimeZone());
}
