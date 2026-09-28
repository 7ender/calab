import { create } from '@bufbuild/protobuf';
import { ListMemberBirthdaysResponseSchema, type ListMemberBirthdaysResponse, type MemberBirthday } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api/endpoints';
import type { BirthdayLike } from '../../lib/birthday';
import { queryClient } from '../../lib/queryClient';

/*
 * Members' birthdays as an admin sees them (docs/09 #77): GET …/members/birthdays has the hidden
 * ones too (marked), which the users map never gets. One query per workspace, shared by the
 * «Изменить день рождения» dialog and the «Участники → Дни рождения» table; USER_UPDATE
 * invalidates it (services/dispatch.ts).
 */

export const memberBirthdaysKey = (workspaceId: string): readonly unknown[] => ['member-birthdays', workspaceId];

const byUser = (d: ListMemberBirthdaysResponse): Record<string, MemberBirthday> => Object.fromEntries(d.birthdays.map((b) => [b.userId, b]));

/** userId → their birthday (absent = none); undefined while loading. */
export function useMemberBirthdays(workspaceId: string): Record<string, MemberBirthday> | undefined {
  return useQuery({ queryKey: memberBirthdaysKey(workspaceId), queryFn: () => api.workspaces.memberBirthdays(workspaceId), select: byUser, staleTime: 30_000 }).data;
}

/** Sets (null: clears) a member's birthday and updates the shared query; throws the API error. */
export async function saveMemberBirthday(workspaceId: string, userId: string, b: BirthdayLike | null): Promise<void> {
  const r = await api.workspaces.setMemberBirthday(workspaceId, userId, b ? { birthday: b } : {});
  const next = r.birthday;
  queryClient.setQueryData<ListMemberBirthdaysResponse>(memberBirthdaysKey(workspaceId), (old) => {
    if (!old) return old;
    const rest = old.birthdays.filter((x) => x.userId !== userId);
    return create(ListMemberBirthdaysResponseSchema, { birthdays: next?.birthday ? [...rest, next] : rest });
  });
  // «Ближайшие дни рождения» above the member list.
  void queryClient.invalidateQueries({ queryKey: ['birthdays', workspaceId] });
}
