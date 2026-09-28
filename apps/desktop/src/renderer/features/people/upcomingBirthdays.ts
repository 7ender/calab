import { WorkspaceRole, type UpcomingBirthday } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/endpoints';
import { useWorkspaces } from '../../stores/workspaces';

/*
 * Birthdays of the next 7 days (docs/09 #76): GET /api/workspaces/{id}/birthdays?days=7, one
 * cached query per workspace shared by the members panel («🎂 Дни рождения») and the settings'
 * «Ближайшие дни рождения». Refreshed hourly (the day turns) and on USER_UPDATE with a changed
 * birthday (services/dispatch.ts). Guests get 403 there: no request for them.
 */

const HOUR = 60 * 60_000;

export const upcomingBirthdaysKey = (workspaceId: string): readonly unknown[] => ['birthdays', workspaceId];

const list = (d: { birthdays: UpcomingBirthday[] }): UpcomingBirthday[] => d.birthdays;

/** Soonest first; undefined while loading (or for a guest). */
export function useUpcomingBirthdays(workspaceId: string): UpcomingBirthday[] | undefined {
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  return useQuery({
    queryKey: upcomingBirthdaysKey(workspaceId),
    queryFn: () => api.workspaces.birthdays(workspaceId, 7),
    select: list,
    enabled: !!workspaceId && !guest,
    staleTime: HOUR,
    refetchInterval: HOUR,
  }).data;
}
