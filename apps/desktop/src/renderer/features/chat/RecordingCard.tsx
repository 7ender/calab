import type { RecordingCard as Card } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { cardStatus, durationText } from '../../lib/recording';
import { platform } from '../../platform';
import { useMemberName } from '../../stores/workspaces';
import type { ChatMessage } from '../../stores/messages';

/**
 * The chat card of a meeting recording (ADR-0025, docs/08 «Запись встреч»): a system message,
 * centred in the feed like a date pill but a card — the REC glyph, «Встреча записана · 42 мин»,
 * who started it and when, the status (Загрузка… / Обработка… / Готово / Ошибка: …) and «Открыть в
 * GPTunneL» once the recording has a page. MESSAGE_UPDATE replaces the message: the card follows.
 */
export function RecordingCardView({ c, card, workspaceId }: { c: ChatMessage; card: Card; workspaceId: string }): ReactNode {
  const by = useMemberName(workspaceId, card.startedBy || c.msg.authorId);
  const started = card.startedAt ? timestampDate(card.startedAt) : toDate(c.msg.createdAt);
  const status = cardStatus(card);
  const title = `${t('rec.card.title')} · ${durationText(card.durationSec)}`;
  const StatusIcon = status.tone === 'ok' ? CheckCircle2 : status.tone === 'error' ? AlertCircle : Loader2;
  return (
    <div
      role="article"
      aria-label={`${title}. ${t(status.key)}`}
      data-testid="recording-card"
      data-status={status.tone}
      className="flex w-full max-w-[440px] items-start gap-3 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-3 py-2.5 shadow-[var(--shadow-card)]"
    >
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[10px] font-bold tracking-wide text-danger-text"
      >
        {t('rec.badge')}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-semibold text-fg">{title}</span>
        <span className="truncate text-caption text-muted">{t('rec.card.meta', { name: by, time: fmt.dateTime(started, 'short') })}</span>
        <span
          className={cx(
            'mt-0.5 flex items-start gap-1.5 text-caption',
            status.tone === 'ok' ? 'text-[var(--color-green-text)]' : status.tone === 'error' ? 'text-danger-text' : 'text-muted',
          )}
          data-testid="recording-card-status"
        >
          <StatusIcon className={cx('mt-px size-3.5 shrink-0', status.tone === 'busy' && 'animate-spin motion-reduce:animate-none')} aria-hidden />
          <span className="min-w-0">{t(status.key)}</span>
        </span>
        {card.webUrl ? (
          <div className="pt-1.5">
            <Button size="sm" variant="secondary" onClick={() => void platform.app.openExternal(card.webUrl)}>
              {t('rec.card.open')}
              <ExternalLink className="size-3" aria-hidden />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
