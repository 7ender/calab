import { WorkspaceRole, type RecordingCard as Card } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { cardStatus, durationText, retryActions, type RetryAction } from '../../lib/recording';
import { platform } from '../../platform';
import { retryRecording } from '../../services/recording';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import type { ChatMessage } from '../../stores/messages';

/**
 * The chat card of a meeting recording (ADR-0025, docs/08 «Запись встреч»): a system message,
 * centred in the feed like a date pill but a card — the REC glyph, «Встреча записана · 42 мин»,
 * who started it and when, the status (Загрузка… / Обработка… / Готово / Ошибка: …) and «Открыть в
 * GPTunneL» once the recording has a page. MESSAGE_UPDATE replaces the message: the card follows.
 * A failed card offers a retry (docs/09 #40, not to guests): «Проверить снова» when the file was
 * delivered, «Отправить снова» when the upload did not complete and the server still has the file.
 */
export function RecordingCardView({ c, card, workspaceId }: { c: ChatMessage; card: Card; workspaceId: string }): ReactNode {
  const by = useMemberName(workspaceId, card.startedBy || c.msg.authorId);
  const started = card.startedAt ? timestampDate(card.startedAt) : toDate(c.msg.createdAt);
  const status = cardStatus(card);
  const title = `${t('rec.card.title')} · ${durationText(card.durationSec)}`;
  const StatusIcon = status.tone === 'ok' ? CheckCircle2 : status.tone === 'error' ? AlertCircle : Loader2;
  const guest = useWorkspaces((s) => s.byId[workspaceId]?.role === WorkspaceRole.GUEST);
  const retries = guest ? [] : retryActions(card);
  const [busy, setBusy] = useState<RetryAction | null>(null);
  const retry = (action: RetryAction): void => {
    setBusy(action);
    void retryRecording(c.msg.roomId, card.recordingId, action, workspaceId).finally(() => setBusy(null));
  };
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
        {card.webUrl || retries.length > 0 ? (
          <div className="flex flex-wrap gap-2 pt-1.5">
            {retries.map((a) => (
              <Button key={a} size="sm" variant="secondary" busy={busy === a} disabled={busy !== null} onClick={() => retry(a)} data-testid={`recording-card-${a}`}>
                {busy === a ? null : a === 'recheck' ? <RefreshCw className="size-3" aria-hidden /> : <Upload className="size-3" aria-hidden />}
                {t(a === 'recheck' ? 'rec.card.recheck' : 'rec.card.reupload')}
              </Button>
            ))}
            {card.webUrl ? (
              <Button size="sm" variant="secondary" onClick={() => void platform.app.openExternal(card.webUrl)}>
                {t('rec.card.open')}
                <ExternalLink className="size-3" aria-hidden />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
