import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { reactionTipMore } from './reactionTipMore';

/** One page is enough to answer «who reacted»; the rest surfaces as the «and N more» tail. */
const REACTION_TIP_LIMIT = 10;

/** A reactor's display name — nickname-aware (memberName), reactive to profile edits. */
function ReactorName({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  return <span className="truncate">{useMemberName(workspaceId || null, userId)}</span>;
}

/**
 * Who reacted with `emoji` — the content of the chip's Tip. Radix mounts the tooltip only
 * while it is open, so the fetch happens strictly on demand; `count` in the key makes the
 * next open refetch after the reaction set changed (MESSAGE_REACTION_ADD/REMOVE).
 */
export function ReactionTip({ workspaceId, messageId, emoji, count }: { workspaceId: string; messageId: string; emoji: string; count: number }): ReactNode {
  const q = useQuery({
    queryKey: ['reaction-users', messageId, emoji, count],
    queryFn: ({ signal }) => api.messages.reactionUsers(messageId, emoji, { limit: REACTION_TIP_LIMIT }, signal),
    // Every open refetches: a same-count change of the set (one out, one in) stays fresh too.
    staleTime: 0,
  });
  // Let memberName() resolve a reactor who is not (or no longer) in the member list.
  useEffect(() => {
    for (const u of q.data?.users ?? []) useWorkspaces.getState().upsertUser(u);
  }, [q.data]);
  if (q.isPending) return <span className="text-faint">{t('common.loading')}</span>;
  const users = q.data?.users ?? [];
  if (q.isError || !users.length) return <span>{t('chat.reactionLabel', { emoji, count })}</span>;
  const more = reactionTipMore(users.length, count);
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-0.5" data-testid="reaction-users">
      <span className="text-faint">{t('chat.reactedWith', { emoji })}</span>
      {users.map((u) => (
        <ReactorName key={u.id} workspaceId={workspaceId} userId={u.id} />
      ))}
      {more ? <span className="text-faint">{more}</span> : null}
    </span>
  );
}
