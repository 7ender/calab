import type { FileMeta, Message, PermissionBits } from '@calaba/protocol';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { AlertCircle, Check, CheckCheck, Clock3, Download, FileText, RotateCw } from 'lucide-react';
import { memo, useCallback, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { fmtFull, fmtSize, fmtTime, toDate } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { firstLink, isEmojiOnly, parseMarkdown } from '../../lib/markdown/parse';
import { platform } from '../../platform';
import { retrySend, toggleReaction } from '../../services/chat';
import { useMessages, type ChatMessage, type PendingUpload } from '../../stores/messages';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { userColorIndex, type RowMeta } from './grouping';
import { LinkPreview } from './LinkPreview';
import { previewText, useMentionLabel } from './mentionText';
import { MessageMenu } from './MessageMenu';

/** Widest image inside a bubble (docs/09 #36). */
const IMAGE_MAX = 420;
const IMAGE_MAX_H = 460;

/** Mention chip in a message: my mentions (me, @everyone, @here) on a warm tint, others accent. */
function MentionChip({ workspaceId, v, own }: { workspaceId: string; v: string; own: boolean }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const label = useMentionLabel(workspaceId, v);
  const mine = !own && (v === me || v === 'everyone' || v === 'here');
  return (
    <span className={cx('rounded-[4px] px-0.5 font-medium', mine ? 'bg-warn/25 text-fg' : 'bg-accent/15 text-accent-text')} data-mention={v}>
      {label}
    </span>
  );
}

export const isImage = (f: FileMeta): boolean => f.mime.startsWith('image/') && !!f.thumbnailUrl;

export interface RowProps {
  c: ChatMessage;
  meta: RowMeta;
  own: boolean;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
  highlighted: boolean;
}

/** One feed row: optional date / «new» pills, avatar column (others), the bubble. */
export const MessageRow = memo(function MessageRow({ c, meta, own, workspaceId, roomId, perms, highlighted }: RowProps): ReactNode {
  const m = c.msg;
  const author = useWorkspaces((s) => s.users[m.authorId]);
  const name = memberName(workspaceId, m.authorId);
  return (
    <div className={cx('pl-4', own ? 'pr-6' : 'pr-4', meta.first ? 'pt-2' : 'pt-0.5')} data-message-id={c.key} data-day-start={meta.day ? '1' : undefined}>
      {meta.day ? <DatePill date={toDate(m.createdAt)} /> : null}
      {meta.isNew ? <NewMessagesPill /> : null}
      <div
        className={cx(
          'flex items-end gap-3 rounded-[var(--radius-card)] transition-[background-color,box-shadow] duration-[var(--motion-fast)]',
          // Telegram tints the message whose menu is open (Radix marks the trigger data-state=open).
          'has-[>[data-state=open]]:bg-[var(--color-bubble-highlight)] has-[>[data-state=open]]:shadow-[0_0_0_4px_var(--color-bubble-highlight)]',
          own ? 'justify-end' : 'justify-start',
          highlighted && 'row-highlight',
        )}
      >
        {!own ? (
          <div className="w-9 shrink-0 self-end">
            {meta.last ? <Avatar userId={m.authorId} name={name} fileId={author?.avatarFileId || undefined} size={36} /> : null}
          </div>
        ) : null}
        <Bubble c={c} meta={meta} own={own} name={name} workspaceId={workspaceId} roomId={roomId} perms={perms} />
      </div>
      {c.status === 'failed' ? <FailedLine c={c} workspaceId={workspaceId} roomId={roomId} /> : null}
    </div>
  );
});

/** Date / «new» pills: 24 px, 12/500, dense popover glass with a 0.5 px hairline (UX review). */
const pill = 'mat-glass inline-flex h-6 items-center rounded-full px-2.5 text-caption font-medium';

export function DatePill({ date, floating }: { date: Date; floating?: boolean }): ReactNode {
  if (floating) {
    return (
      <span className={cx(pill, 'text-fg')} aria-hidden data-testid="sticky-date">
        {fmtDayLabel(date)}
      </span>
    );
  }
  return (
    <div className="flex justify-center py-2" role="separator" aria-label={fmtDayLabel(date)}>
      <span className={cx(pill, 'text-fg')}>{fmtDayLabel(date)}</span>
    </div>
  );
}

/** «Новые сообщения» (Telegram): accent text on the pill glass, hairlines to both sides. */
function NewMessagesPill(): ReactNode {
  const line = 'h-px flex-1 bg-[color-mix(in_srgb,var(--color-accent)_40%,transparent)]';
  return (
    <div className="flex items-center gap-3 py-2" role="separator" aria-label={t('chat.newPill')}>
      <span className={line} aria-hidden />
      <span className={cx(pill, 'text-accent-text')}>{t('chat.newPill')}</span>
      <span className={line} aria-hidden />
    </div>
  );
}

const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const dayYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

/** «Сегодня», «Вчера», «14 января», «14 января 2025» (year only when not the current one). */
export function fmtDayLabel(d: Date, now = new Date()): string {
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return t('chat.today');
  if (d.toDateString() === y.toDateString()) return t('chat.yesterday');
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

function Bubble({
  c,
  meta,
  own,
  name,
  workspaceId,
  roomId,
  perms,
}: {
  c: ChatMessage;
  meta: RowMeta;
  own: boolean;
  name: string;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
}): ReactNode {
  const m = c.msg;
  const mention = useCallback((v: string, key: string) => <MentionChip key={key} workspaceId={workspaceId} v={v} own={own} />, [workspaceId, own]);
  const nodes = useMemo(() => parseMarkdown(m.content), [m.content]);
  // In-room search: 0 = not a hit, 1 = hit, 2 = the current hit (primitive → no extra renders).
  const hit = useChatView((s) => (s.searchHits?.roomId === roomId && s.searchHits.ids.has(m.id) ? (s.searchHits.current === m.id ? 2 : 1) : 0));
  const words = useChatView((s) => s.searchHits?.words);
  const highlight = useMemo(() => (hit && words?.length ? { words, current: hit === 2 } : undefined), [hit, words]);
  const link = useMemo(() => firstLink(nodes), [nodes]);
  const images = m.attachments.filter(isImage);
  const files = m.attachments.filter((f) => !isImage(f));
  const uploads = c.uploads && c.status !== 'sent' ? c.uploads : [];
  const hasText = !!m.content.trim();
  const sticker = hasText && !images.length && !files.length && !uploads.length && !m.replyToId && !m.reactions.length && isEmojiOnly(m.content);
  const showName = !own && meta.first && !sticker;
  const imageOnly = images.length > 0 && !hasText && !files.length && !m.replyToId && !showName && !m.reactions.length;
  const width = images.length ? imageBoxWidth(images) : undefined;

  const metaNode = <MetaInfo c={c} own={own} />;
  const tail = meta.last && !sticker;

  // Corner radii: large outside, small where bubbles of one group touch, none under the tail.
  const r = 'var(--radius-bubble)';
  const ri = 'var(--radius-bubble-inner)';
  const radius: CSSProperties = own
    ? { borderRadius: `${r} ${meta.first ? r : ri} ${tail ? '0' : ri} ${r}` }
    : { borderRadius: `${meta.first ? r : ri} ${r} ${r} ${tail ? '0' : ri}` };
  if (meta.last && !tail) Object.assign(radius, own ? { borderBottomRightRadius: r } : { borderBottomLeftRadius: r });

  const body = sticker ? (
    <div className="flex flex-col items-end gap-1">
      <span className="text-[44px] leading-none">{m.content.trim()}</span>
      <span className="rounded-full bg-[var(--bubble-bg)] px-2 py-0.5 shadow-[var(--shadow-bubble)]">{metaNode}</span>
    </div>
  ) : (
    <div
      className="relative bg-[var(--bubble-bg)] shadow-[var(--shadow-bubble)]"
      style={{ ...radius, ...(width ? { width } : {}) }}
    >
      {tail ? <Tail own={own} /> : null}
      <div className="overflow-hidden" style={radius}>
        {showName ? (
          <div className="truncate px-3 pt-1.5 text-body font-semibold leading-[18px]" style={{ color: `var(--name-${userColorIndex(m.authorId) + 1})` }} title={name}>
            {name}
          </div>
        ) : null}
        {m.replyToId ? <ReplyQuote roomId={roomId} workspaceId={workspaceId} replyToId={m.replyToId} padTop={!showName} /> : null}
        {images.length ? (
          <ImageGrid files={images} width={width ?? IMAGE_MAX} padTop={showName || !!m.replyToId} overlay={imageOnly ? metaNode : null} />
        ) : null}
        {uploads.length ? <Uploads uploads={uploads} /> : null}
        {hasText ? (
          <div className="selectable whitespace-pre-wrap break-words px-3 pb-1.5 pt-1.5 text-list leading-5 [overflow-wrap:anywhere]">
            <Markdown text={m.content} mention={mention} highlight={highlight} />
            {!link && !files.length && !m.reactions.length ? (
              // Reserve room for the time on the last line (it is drawn absolutely, Telegram-style).
              <span className="invisible ml-2 inline-flex select-none" aria-hidden>
                {metaNode}
              </span>
            ) : null}
          </div>
        ) : null}
        {link && hasText ? (
          <div className="px-3 pb-1">
            <LinkPreview url={link} />
          </div>
        ) : null}
        {files.length ? (
          <div className={cx('flex flex-col gap-1 px-3 pb-1', hasText || showName || m.replyToId ? 'pt-0.5' : 'pt-2')}>
            {files.map((f) => (
              <FileRow key={f.id} f={f} />
            ))}
          </div>
        ) : null}
        {m.reactions.length ? (
          <div className="flex flex-wrap items-end gap-1 px-2.5 pb-1.5 pt-0.5">
            {m.reactions.map((re) => (
              <ReactionChip key={re.emoji} roomId={roomId} m={m} emoji={re.emoji} count={re.count} me={re.me} canReact={c.status === 'sent'} />
            ))}
            <span className="ml-auto pl-2">{metaNode}</span>
          </div>
        ) : imageOnly ? null : hasText && !link && !files.length ? (
          <span className="absolute bottom-1 right-3">{metaNode}</span>
        ) : (
          <div className="flex justify-end px-3 pb-1.5">{metaNode}</div>
        )}
      </div>
    </div>
  );

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild disabled={c.status !== 'sent'}>
        <div
          className={cx('relative min-w-0 max-w-[min(70%,640px)]', own ? 'bubble-out' : 'bubble-in', c.status === 'pending' && 'opacity-80')}
          data-testid="message-bubble"
          data-own={own || undefined}
        >
          {body}
        </div>
      </ContextMenu.Trigger>
      <MessageMenu c={c} own={own} roomId={roomId} perms={perms} />
    </ContextMenu.Root>
  );
}

/** Bubble tail (Telegram): a curved corner piece in the bubble colour at the bottom. */
function Tail({ own }: { own: boolean }): ReactNode {
  return (
    <svg
      aria-hidden
      width="10"
      height="16"
      viewBox="0 0 10 16"
      className={cx('absolute bottom-0 fill-[var(--bubble-bg)]', own ? '-right-[9px]' : '-left-[9px] -scale-x-100')}
    >
      <path d="M0 0v16h10c-5.5-1.2-9.2-5.6-10-12z" />
    </svg>
  );
}

function MetaInfo({ c, own }: { c: ChatMessage; own: boolean }): ReactNode {
  const d = toDate(c.msg.createdAt);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-caption leading-none text-[color:var(--bubble-meta)]">
      {c.msg.editedAt ? <span>{t('chat.editedShort')}</span> : null}
      <Tip label={fmtFull(d)}>
        <span>{fmtTime(d)}</span>
      </Tip>
      {own ? (
        c.status === 'pending' ? (
          <Clock3 className="size-3.5" aria-label={t('chat.statusPending')} />
        ) : c.status === 'failed' ? (
          <AlertCircle className="size-3.5 text-danger" aria-label={t('chat.failed')} />
        ) : c.delivered === false ? (
          <Check className="size-4" aria-label={t('chat.statusSent')} />
        ) : (
          <CheckCheck className="size-4" aria-label={t('chat.statusDelivered')} />
        )
      ) : null}
    </span>
  );
}

function ReactionChip({ roomId, m, emoji, count, me, canReact }: { roomId: string; m: Message; emoji: string; count: number; me: boolean; canReact: boolean }): ReactNode {
  return (
    <button
      type="button"
      disabled={!canReact}
      aria-pressed={me}
      aria-label={t('chat.reactionLabel', { emoji, count })}
      onClick={() => void toggleReaction(roomId, m, emoji)}
      className={cx(
        'inline-flex h-7 items-center gap-1 rounded-full px-2 text-body leading-none transition-colors duration-[var(--motion-fast)]',
        me
          ? 'bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]'
          : 'bg-[color-mix(in_srgb,var(--bubble-accent)_14%,transparent)] text-fg hover:bg-[color-mix(in_srgb,var(--bubble-accent)_22%,transparent)]',
      )}
    >
      <span className="text-headline">{emoji}</span>
      <span className="text-body font-semibold tabular-nums">{count}</span>
    </button>
  );
}

function ReplyQuote({ roomId, workspaceId, replyToId, padTop }: { roomId: string; workspaceId: string; replyToId: string; padTop: boolean }): ReactNode {
  const target = useMessages((s) => s.rooms[roomId]?.items.find((c) => c.key === replyToId)?.msg);
  const jump = useChatView((s) => s.requestJump);
  const snippet = target ? previewText(workspaceId, target.content).slice(0, 140) || (target.attachments.length ? t('chat.attachment') : '') : '';
  const who = target ? memberName(workspaceId, target.authorId) : t('chat.reply');
  return (
    <div className={cx('px-2 pb-0.5', padTop ? 'pt-2' : 'pt-1')}>
      <button
        type="button"
        onClick={() => jump(roomId, replyToId)}
        className="flex w-full min-w-0 flex-col rounded-[var(--radius-control)] border-l-[3px] border-[color:var(--bubble-accent)] bg-[color-mix(in_srgb,var(--bubble-accent)_12%,transparent)] px-2 py-1 text-left hover:bg-[color-mix(in_srgb,var(--bubble-accent)_18%,transparent)]"
      >
        <span className="truncate text-body font-semibold text-[color:var(--bubble-accent)]">{who}</span>
        <span className="truncate text-body text-fg">{target ? snippet : t('chat.replyOpen')}</span>
      </button>
    </div>
  );
}

function imageBoxWidth(files: FileMeta[]): number {
  if (files.length > 1) return IMAGE_MAX;
  const f = files[0];
  if (!f?.width || !f.height) return 320;
  const w = Math.min(IMAGE_MAX, f.width);
  const h = (w * f.height) / f.width;
  return Math.max(200, Math.round(h > IMAGE_MAX_H ? (IMAGE_MAX_H * f.width) / f.height : w));
}

function ImageGrid({ files, width, padTop, overlay }: { files: FileMeta[]; width: number; padTop: boolean; overlay: ReactNode }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const single = files.length === 1 ? files[0] : undefined;
  const aspect = single?.width && single.height ? `${single.width} / ${single.height}` : undefined;
  return (
    <div className={cx('relative grid gap-0.5', files.length > 1 && 'grid-cols-2', padTop && 'pt-1.5')} style={{ width: '100%' }}>
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          aria-label={t('chat.openImage', { name: f.name })}
          onClick={() => open({ kind: 'image', fileId: f.id, name: f.name })}
          className="block overflow-hidden bg-[color-mix(in_srgb,var(--bubble-accent)_10%,transparent)] focus-visible:outline-offset-[-2px]"
          style={single ? { aspectRatio: aspect ?? '4 / 3', maxHeight: IMAGE_MAX_H, width } : { aspectRatio: '1 / 1' }}
        >
          <MediaImg path={thumbnailPath(f.id)} alt={f.name} loading="lazy" className="block size-full object-cover" draggable={false} />
        </button>
      ))}
      {overlay ? (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded-full bg-[rgb(0_0_0/50%)] px-1.5 py-1 [--bubble-meta:var(--color-on-accent)]">{overlay}</span>
      ) : null}
    </div>
  );
}

function FileRow({ f }: { f: FileMeta }): ReactNode {
  const download = (): void =>
    void platform.files.download({ fileId: f.id, name: f.name }).then(
      () => toast.success(t('chat.downloaded', { name: f.name })),
      (e: unknown) => toast.fail(e, t('err.ctx.download')),
    );
  return (
    <div className="group/file flex min-w-[220px] items-center gap-3 py-1">
      <Tip label={t('chat.download')}>
        <button
          type="button"
          onClick={download}
          aria-label={`${t('chat.download')} ${f.name}`}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--bubble-chip-bg)] text-[color:var(--bubble-chip-fg)]"
        >
          <FileText className="size-5 group-hover/file:hidden" aria-hidden />
          <Download className="hidden size-5 group-hover/file:block" aria-hidden />
        </button>
      </Tip>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium" title={f.name}>
          {f.name}
        </div>
        <div className="text-caption text-[color:var(--bubble-meta)]">{fmtSize(f.size)}</div>
      </div>
    </div>
  );
}

function Uploads({ uploads }: { uploads: PendingUpload[] }): ReactNode {
  return (
    <div className="flex min-w-[240px] flex-col gap-1.5 px-3 pt-2">
      {uploads.map((u) => (
        <div key={u.key}>
          <div className="flex justify-between gap-3 text-caption">
            <span className="truncate">{u.name}</span>
            <span className="shrink-0 text-[color:var(--bubble-meta)]">{Math.round(u.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-[color-mix(in_srgb,var(--bubble-accent)_20%,transparent)]">
            <div className="h-full rounded-full bg-[color:var(--bubble-accent)] transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function FailedLine({ c, workspaceId, roomId }: { c: ChatMessage; workspaceId: string; roomId: string }): ReactNode {
  return (
    <div className="mt-1 flex items-center justify-end gap-2 text-caption text-danger-text">
      <span className="truncate">
        {t('chat.failed')}
        {c.error ? `: ${c.error}` : ''}
      </span>
      <button type="button" className="inline-flex items-center gap-0.5 font-semibold hover:underline" onClick={() => void retrySend(workspaceId, roomId, c)}>
        <RotateCw className="size-3" aria-hidden /> {t('common.retry')}
      </button>
      <button type="button" className="hover:underline" onClick={() => useMessages.getState().dropPending(roomId, c.key)}>
        {t('common.delete')}
      </button>
    </div>
  );
}
