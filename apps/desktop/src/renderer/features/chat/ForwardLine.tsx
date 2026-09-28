import { Forward } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt } from '../../lib/format';
import { useWorkspaces } from '../../stores/workspaces';

/**
 * «↪ Переслано от <имя> · <дата>» above a forwarded copy (ADR-0033 §5, docs/08 «Лента»): one
 * caption line in the muted colour (the bubble's meta colour inside a bubble), the name by
 * Forward.author_id — the nickname in this workspace, else the profile name, else «участника».
 * Primitive props: a MESSAGE_UPDATE of the copy does not re-render it.
 */
export const ForwardLine = memo(function ForwardLine({
  authorId,
  sentAtMs,
  workspaceId,
  className,
}: {
  authorId: string;
  /** Forward.sent_at in ms; 0 = unknown (no date). */
  sentAtMs: number;
  workspaceId: string;
  className?: string;
}): ReactNode {
  const known = useWorkspaces((st) => {
    if (!authorId) return '';
    const m = workspaceId ? st.byId[workspaceId]?.members[authorId] : undefined;
    return m?.nickname || m?.user?.displayName || st.users[authorId]?.displayName || '';
  });
  const name = known || t('chat.fwd.someone');
  const text = sentAtMs ? t('chat.fwd.fromMeta', { name, time: fmt.dateTime(new Date(sentAtMs), 'short') }) : t('chat.fwd.from', { name });
  return (
    <div className={cx('flex min-w-0 items-center gap-1 text-caption', className)} data-testid="forward-line">
      <Forward className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    </div>
  );
});

/** Forward.sent_at of a message in ms (0 = none): a primitive for ForwardLine's memo. */
export function forwardSentMs(sentAt: { seconds: bigint; nanos: number } | undefined): number {
  return sentAt ? Number(sentAt.seconds) * 1000 + Math.floor(sentAt.nanos / 1e6) : 0;
}
