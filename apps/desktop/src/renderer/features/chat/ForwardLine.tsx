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
 * The date is when the copy was forwarded (its own created_at); the original's Forward.sent_at
 * goes to the tooltip («Оригинал: <дата>»).
 * Primitive props: a MESSAGE_UPDATE of the copy does not re-render it.
 */
export const ForwardLine = memo(function ForwardLine({
  authorId,
  forwardedAtMs,
  sentAtMs,
  workspaceId,
  className,
}: {
  authorId: string;
  /** The copy's own created_at (the forward time) in ms; 0 = unknown (no date, e.g. pending). */
  forwardedAtMs: number;
  /** Forward.sent_at (the original's time) in ms, for the tooltip; 0 = unknown. */
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
  const text = forwardedAtMs
    ? t('chat.fwd.fromMeta', { name, time: fmt.dateTime(new Date(forwardedAtMs), 'short') })
    : t('chat.fwd.from', { name });
  // The full line (it may be truncated) plus the original's date on the next line.
  const title = sentAtMs ? `${text}\n${t('chat.fwd.original', { time: fmt.dateTime(new Date(sentAtMs), 'short') })}` : text;
  return (
    <div className={cx('flex min-w-0 items-center gap-1 text-caption', className)} data-testid="forward-line">
      <Forward className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate" title={title}>
        {text}
      </span>
    </div>
  );
});

/** A timestamp (Forward.sent_at, Message.created_at) in ms (0 = none): a primitive for ForwardLine's memo. */
export function forwardSentMs(ts: { seconds: bigint; nanos: number } | undefined): number {
  return ts ? Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6) : 0;
}
