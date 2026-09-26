import type { Me } from '@calaba/protocol';
import { api } from '../lib/api/endpoints';
import { log } from '../lib/log';
import { localTimeZone, timeZoneLabel } from '../lib/timezone';
import { useSession } from '../stores/session';
import { useWorkspaces } from '../stores/workspaces';

/** The account whose zone was checked in this sign-in (null: not yet / signed out). */
let syncedFor: string | null = null;

/**
 * Once per sign-in (on READY): tell the server this device's IANA zone when the profile has
 * another one (or none) — others see «(+3 UTC)» next to my name (User.timezone). A failure (422)
 * is not retried until the next sign-in; another account signed in afterwards is checked too.
 */
export function syncTimeZone(me: Me | null | undefined): void {
  const user = me?.user;
  if (!user?.id || syncedFor === user.id) return;
  syncedFor = user.id;
  const tz = localTimeZone();
  if (!tz || user.timezone === tz) return;
  void api.me
    .update({ timezone: tz })
    .then((r) => {
      if (r.me) useSession.getState().set({ me: r.me });
    })
    .catch((e: unknown) => log.warn('time zone sync failed', e));
}

/** Sign-out: the next account (or the same one again) gets its zone checked on its READY. */
export function resetTimeZoneSync(): void {
  syncedFor = null;
}

/** «(+5 UTC)» for a member whose zone differs from mine right now, else null. */
export function useTimeZoneLabel(userId: string): string | null {
  const theirs = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  return timeZoneLabel(theirs, localTimeZone());
}
