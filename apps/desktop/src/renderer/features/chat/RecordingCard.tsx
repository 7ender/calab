import { WorkspaceRole, type PermissionBits, type RecordingCard as Card } from '@calaba/protocol';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { AlertCircle, CheckCircle2, Copy, FileText, Forward, Loader2, MoreHorizontal, Play, RefreshCw, Trash2, Upload } from 'lucide-react';
import { lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { mayDeleteRecording, recordingAudio, summaryBlocks, summaryPlainText } from '../../lib/meetingResult';
import { can } from '../../lib/permissions';
import { cardStatus, durationText, retryActions, type RetryAction } from '../../lib/recording';
import { openForward } from '../../services/forward';
import { deleteRecording, retryRecording } from '../../services/recording';
import { usePlayer, type Track } from '../../stores/player';
import { toast } from '../../stores/toasts';
import { useSession } from '../../stores/session';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import type { ChatMessage } from '../../stores/messages';
import { menuBox, menuItem } from '../shell/menu';
import { AudioAttachment } from './MediaPlayer';

const RecordingTranscript = lazy(() => import('./RecordingTranscript'));

/**
 * The chat card of a meeting recording (ADR-0025, docs/08 «Запись встреч», docs/09 #47 / #50): a
 * system message across the whole feed (no bubble). The REC glyph, «Встреча записана · 42 мин»,
 * who started it and when, the status (Загрузка… / Обработка… / Готово / Ошибка: …); once done —
 * GPTunneL's summary (6 lines, «Показать всё»), «Послушать запись» (our copy of the audio, the
 * chat's player) and «Полный транскрипт» (no «Открыть в GPTunneL»: owner, 28.09, #80). A failed
 * card offers a retry (#40, not to guests); «…» → «Переслать» (ADR-0033), «Копировать самари»
 * (#80) and «Удалить запись» (who started it, the owner, MANAGE_MESSAGES). A forwarded copy
 * (Message.forward) is the same card without the retry and delete actions: they belong to the
 * recording's own room.
 * MESSAGE_UPDATE replaces the message: the card follows.
 */
export function RecordingCardView({ c, card, workspaceId, perms }: { c: ChatMessage; card: Card; workspaceId: string; perms: PermissionBits }): ReactNode {
  const by = useMemberName(workspaceId, card.startedBy || c.msg.authorId);
  const deletedBy = useMemberName(workspaceId, card.deletedBy);
  const started = card.startedAt ? timestampDate(card.startedAt) : toDate(c.msg.createdAt);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [busy, setBusy] = useState<RetryAction | null>(null);
  const [transcript, setTranscript] = useState(false);
  const title = `${t('rec.card.title')} · ${durationText(card.durationSec)}`;

  if (card.deletedAt) {
    return (
      <article aria-label={t('rec.card.deleted')} data-testid="recording-card" data-status="deleted" className="rec-card flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-4 py-2.5">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-hover text-muted">
          <Trash2 className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body font-semibold text-muted">{t('rec.card.deleted')}</span>
          <span className="truncate text-caption text-muted">{t('rec.card.deletedMeta', { name: deletedBy, time: fmt.dateTime(timestampDate(card.deletedAt), 'short') })}</span>
        </div>
      </article>
    );
  }

  const status = cardStatus(card);
  const StatusIcon = status.tone === 'ok' ? CheckCircle2 : status.tone === 'error' ? AlertCircle : Loader2;
  const guest = role === WorkspaceRole.GUEST;
  const copy = !!c.msg.forward;
  const retries = guest || copy ? [] : retryActions(card);
  const audio = recordingAudio(card, c.msg.attachments);
  const mayDelete = !copy && mayDeleteRecording(card, me, { owner: role === WorkspaceRole.OWNER, manageMessages: can(perms, 'MANAGE_MESSAGES') });
  const when = fmt.dateTime(started, 'short');
  const retry = (action: RetryAction): void => {
    setBusy(action);
    void retryRecording(c.msg.roomId, card.recordingId, action, workspaceId).finally(() => setBusy(null));
  };
  const track: Track | null = audio
    ? { fileId: audio.id, messageId: c.msg.id, roomId: c.msg.roomId, name: audio.name, title: t('rec.card.label'), subtitle: when }
    : null;
  const hasActions = !!audio || card.hasTranscript || retries.length > 0;

  return (
    <article
      aria-label={`${title}. ${t(status.key)}`}
      data-testid="recording-card"
      data-status={status.tone}
      className="rec-card group/rec flex w-full flex-col gap-2.5 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-4 py-3 shadow-[var(--shadow-card)] mobile:px-3"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-danger)_16%,transparent)] text-[10px] font-bold tracking-wide text-danger-text"
        >
          {t('rec.badge')}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-body font-semibold text-fg">{title}</span>
          <span className="truncate text-caption text-muted">{t('rec.card.meta', { name: by, time: when })}</span>
          <span
            className={cx(
              'mt-0.5 flex items-start gap-1.5 text-caption',
              status.tone === 'ok' ? 'text-[var(--color-green-text)]' : status.tone === 'error' ? 'text-danger-text' : 'text-muted',
            )}
            data-testid="recording-card-status"
          >
            {/* «Идёт запись…» / processing last minutes to hours: the spinner turns 10 times, then
                stands (no endless animation, docs/08 «Движение», docs/09 #64). */}
            <StatusIcon className={cx('mt-px size-3.5 shrink-0', status.tone === 'busy' && 'animate-spin [animation-iteration-count:10] motion-reduce:animate-none')} aria-hidden />
            <span className="min-w-0">{t(status.key)}</span>
          </span>
        </div>
        <CardMenu
          onForward={c.status === 'sent' ? () => openForward(c.msg.roomId, c.msg.id) : undefined}
          onCopy={card.summary ? () => copySummary(card.summary) : undefined}
          onDelete={mayDelete ? () => void deleteRecording(c.msg.roomId, card.recordingId) : undefined}
        />
      </div>

      {card.summary ? <Summary text={card.summary} /> : null}

      {audio && track ? <Listen track={track} file={audio} subtitle={when} /> : null}

      {hasActions ? (
        <div className="flex flex-wrap gap-2">
          {track ? <ListenButton track={track} /> : null}
          {card.hasTranscript ? (
            <Button size="sm" variant="secondary" onClick={() => setTranscript(true)} data-testid="recording-card-transcript">
              <FileText className="size-3" aria-hidden />
              {t('rec.card.transcript')}
            </Button>
          ) : null}
          {retries.map((a) => (
            <Button key={a} size="sm" variant="secondary" busy={busy === a} disabled={busy !== null} onClick={() => retry(a)} data-testid={`recording-card-${a}`}>
              {busy === a ? null : a === 'recheck' ? <RefreshCw className="size-3" aria-hidden /> : <Upload className="size-3" aria-hidden />}
              {t(a === 'recheck' ? 'rec.card.recheck' : 'rec.card.reupload')}
            </Button>
          ))}
        </div>
      ) : null}

      {transcript ? (
        <Suspense fallback={null}>
          <RecordingTranscript roomId={c.msg.roomId} recordingId={card.recordingId} title={title} started={started} track={track} onClose={() => setTranscript(false)} />
        </Suspense>
      ) : null}
    </article>
  );
}

/** «Копировать самари» (docs/09 #80): the summary as plain text, «Скопировано» toast. */
function copySummary(text: string): void {
  navigator.clipboard.writeText(summaryPlainText(text)).then(
    () => toast.success(t('chat.copied')),
    (e: unknown) => toast.fail(e),
  );
}

/** «…» of the card: «Переслать» (ADR-0033), «Копировать самари» (#80), «Удалить запись» (docs/09 #50). */
function CardMenu({ onForward, onCopy, onDelete }: { onForward: (() => void) | undefined; onCopy: (() => void) | undefined; onDelete: (() => void) | undefined }): ReactNode {
  if (!onForward && !onCopy && !onDelete) return null;
  return (
    <Dropdown.Root modal={false}>
      <Dropdown.Trigger asChild>
        <IconButton label={t('rec.card.menu')} size="sm" className="-mr-1.5 -mt-0.5 mobile:-my-2 mobile:-mr-3 mobile:size-11" data-testid="recording-card-menu">
          <MoreHorizontal className="size-4" aria-hidden />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={4} collisionPadding={16} className={menuBox}>
          {onForward ? (
            <Dropdown.Item className={menuItem} onSelect={onForward} data-testid="recording-card-forward">
              <Forward className="size-4" aria-hidden />
              {t('chat.forward')}
            </Dropdown.Item>
          ) : null}
          {onCopy ? (
            <Dropdown.Item className={menuItem} onSelect={onCopy} data-testid="recording-card-copy-summary">
              <Copy className="size-4" aria-hidden />
              {t('rec.card.copySummary')}
            </Dropdown.Item>
          ) : null}
          {onDelete ? (
            <Dropdown.Item className={cx(menuItem, 'text-danger-text')} onSelect={onDelete} data-testid="recording-card-delete">
              <Trash2 className="size-4" aria-hidden />
              {t('rec.delete.item')}
            </Dropdown.Item>
          ) : null}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Summary lines shown folded (docs/08: 4–6 lines); 20 px each. */
const FOLDED_PX = 6 * 20;

/** GPTunneL's summary: headings, lists, inline markdown-lite; folded to 6 lines with «Показать всё». */
function Summary({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setTall(el.scrollHeight > FOLDED_PX + 4);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const blocks = summaryBlocks(text);
  const plain = (v: string): string => `@${v}`;
  return (
    <section aria-label={t('rec.card.summary')} data-testid="recording-card-summary" className="relative border-t border-line pt-2.5">
      {/* «Копировать самари» (#80): on the card's hover / focus on desktop, always on a phone (no hover). */}
      <IconButton
        label={t('rec.card.copySummary')}
        size="sm"
        className="absolute right-0 top-1.5 z-[1] size-6 opacity-0 focus-visible:opacity-100 group-focus-within/rec:opacity-100 group-hover/rec:opacity-100 mobile:top-1 mobile:size-8 mobile:opacity-100"
        onClick={() => copySummary(text)}
        data-testid="recording-card-summary-copy"
      >
        <Copy className="size-3.5" aria-hidden />
      </IconButton>
      <div
        ref={box}
        className={cx('relative pr-7 text-body leading-5 text-fg mobile:pr-9', !open && tall && 'overflow-hidden')}
        style={!open && tall ? { maxHeight: FOLDED_PX, maskImage: 'linear-gradient(to bottom, #000 70%, transparent)' } : undefined}
      >
        {blocks.map((b, i) =>
          b.t === 'h' ? (
            <h4 key={i} className={cx('text-caption font-semibold uppercase tracking-wide text-muted', i > 0 && 'mt-2')}>
              <Markdown text={b.text} mention={plain} />
            </h4>
          ) : b.t === 'li' ? (
            <div key={i} className="flex gap-1.5 pl-1">
              <span aria-hidden className="w-3 shrink-0 text-muted">
                {b.n ? `${b.n}.` : '•'}
              </span>
              <span className="min-w-0 break-words">
                <Markdown text={b.text} mention={plain} />
              </span>
            </div>
          ) : (
            <p key={i} className={cx('break-words', i > 0 && 'mt-1')}>
              <Markdown text={b.text} mention={plain} />
            </p>
          ),
        )}
      </div>
      {tall ? (
        <button type="button" className="mt-1 text-caption font-medium text-accent-text hover:underline mobile:-mb-2 mobile:min-h-8" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="recording-card-more">
          {open ? t('rec.card.less') : t('rec.card.more')}
        </button>
      ) : null}
    </section>
  );
}

const sameTrack = (a: Track | null, b: Track): boolean => !!a && a.fileId === b.fileId && a.messageId === b.messageId;

/** «Послушать запись»: starts the chat's player on the recording (hidden while it is the track). */
function ListenButton({ track }: { track: Track }): ReactNode {
  const active = usePlayer((s) => sameTrack(s.track, track));
  if (active) return null;
  return (
    <Button size="sm" variant="primary" onClick={() => usePlayer.getState().toggle(track)} data-testid="recording-card-listen">
      <Play className="size-3 fill-current" aria-hidden />
      {t('rec.card.listen')}
    </Button>
  );
}

/** The recording's player in the card while it is the chat's track (seek, speed, mini-player). */
function Listen({ track, file, subtitle }: { track: Track; file: Parameters<typeof AudioAttachment>[0]['f']; subtitle: string }): ReactNode {
  const active = usePlayer((s) => sameTrack(s.track, track));
  if (!active) return null;
  return (
    <div className="max-w-[420px]" data-testid="recording-card-player">
      <AudioAttachment f={file} messageId={track.messageId} roomId={track.roomId} label={t('rec.card.label')} subtitle={subtitle} />
    </div>
  );
}
