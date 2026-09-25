import type { FileMeta, PermissionBits } from '@calaba/protocol';
import { Copy, CornerUpLeft, Download, FileText, Pencil, RotateCw, Trash2 } from 'lucide-react';
import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { MediaImg } from '../../components/MediaImg';
import { thumbnailPath } from '../../lib/api/endpoints';
import { fmtDay, fmtFull, fmtSize, fmtStamp, fmtTime, toDate } from '../../lib/format';
import { Markdown } from '../../lib/markdown/Markdown';
import { parseMarkdown, toPlainText } from '../../lib/markdown/parse';
import { can } from '../../lib/permissions';
import { deleteMessage, editMessage, retrySend } from '../../services/chat';
import { mentionsMe } from '../../services/notify';
import { useMessages, type ChatMessage, type PendingUpload } from '../../stores/messages';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import type { RowMeta } from './MessageList';
import { platform } from '../../platform';

function useMentionMatcher(workspaceId: string): (v: string) => boolean {
  const me = useSession((s) => s.me?.user);
  const nick = useWorkspaces((s) => (me ? s.byId[workspaceId]?.members[me.id]?.nickname : ''));
  const names = [me?.displayName ?? '', nick ?? ''].filter(Boolean).map((n) => n.toLowerCase().replace(/\s+/g, ''));
  return (v) => names.includes(v.toLowerCase());
}

export const MessageRow = memo(function MessageRow({
  c,
  meta,
  workspaceId,
  roomId,
  perms,
  isMe,
}: {
  c: ChatMessage;
  meta: RowMeta;
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
  isMe: boolean;
}): ReactNode {
  const m = c.msg;
  const author = useWorkspaces((s) => s.users[m.authorId]);
  const name = memberName(workspaceId, m.authorId);
  const editing = useUi((s) => s.editing === c.key);
  const setEditing = useUi((s) => s.setEditing);
  const setReply = useUi((s) => s.setReply);
  const myNames = useMentionMatcher(workspaceId);
  const date = toDate(m.createdAt);
  const mentioned = !isMe && mentionsMe(m.content, [useSession.getState().me?.user?.displayName ?? '']);
  const canDelete = c.status === 'sent' && (isMe || can(perms, 'MANAGE_MESSAGES'));

  const remove = async (): Promise<void> => {
    if (await confirmAction(t('chat.deleteTitle'), t('chat.deleteText'), t('common.delete'))) await deleteMessage(roomId, m.id);
  };

  return (
    <div>
      {meta.dayDivider ? (
        <div className="mx-4 mb-1 mt-4 flex items-center gap-3 text-[12px] font-semibold text-faint">
          <span className="h-px flex-1 bg-line" />
          {fmtDay(date)}
          <span className="h-px flex-1 bg-line" />
        </div>
      ) : null}
      {meta.newDivider ? (
        <div className="mx-4 my-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-danger-text">
          <span className="h-px flex-1 bg-danger" />
          {t('chat.new')}
        </div>
      ) : null}
      <div
        className={cx(
          'group relative flex gap-3 px-4 hover:bg-hover/40',
          meta.grouped ? 'py-0.5' : 'mt-3 pt-0.5',
          mentioned && 'border-l-2 border-warn bg-mention',
          c.status === 'pending' && 'opacity-60',
        )}
      >
        <div className="w-10 shrink-0">
          {meta.grouped ? (
            <span className="invisible block pt-0.5 text-right text-[10px] text-faint group-hover:visible">{fmtTime(date)}</span>
          ) : (
            <Avatar userId={m.authorId} name={name} fileId={author?.avatarFileId || undefined} size={40} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          {m.replyToId ? <ReplyPreview roomId={roomId} workspaceId={workspaceId} replyToId={m.replyToId} /> : null}
          {!meta.grouped ? (
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-fg">{name}</span>
              <Tip label={fmtFull(date)}>
                <span className="text-[11px] text-faint">{fmtStamp(date)}</span>
              </Tip>
            </div>
          ) : null}
          {editing ? (
            <EditBox initial={m.content} onCancel={() => setEditing(null)} onSave={(text) => { setEditing(null); if (text !== m.content) void editMessage(m.id, text); }} />
          ) : m.content ? (
            <div className="whitespace-pre-wrap break-words leading-[1.45]">
              <Markdown text={m.content} mentionIsMe={myNames} />
              {m.editedAt ? <span className="ml-1 text-[10px] text-faint">{t('chat.edited')}</span> : null}
            </div>
          ) : null}
          {m.attachments.length > 0 ? <Attachments files={m.attachments} /> : null}
          {c.uploads && c.status !== 'sent' ? <Uploads uploads={c.uploads} /> : null}
          {c.status === 'failed' ? (
            <div className="mt-1 flex items-center gap-2 text-[12px] text-danger-text">
              {t('chat.failed')}
              {c.error ? `: ${c.error}` : ''}
              <button type="button" className="font-semibold hover:underline" onClick={() => void retrySend(workspaceId, roomId, c)}>
                <RotateCw className="mr-0.5 inline size-3" /> {t('common.retry')}
              </button>
              <button type="button" className="hover:underline" onClick={() => useMessages.getState().dropPending(roomId, c.key)}>
                {t('common.delete')}
              </button>
            </div>
          ) : null}
        </div>
        {c.status === 'sent' && !editing ? (
          <div className="mat-popover absolute -top-3 right-4 hidden rounded-[var(--radius-card)] p-0.5 group-focus-within:flex group-hover:flex">
            {can(perms, 'SEND_MESSAGES') ? (
              <IconButton label={t('chat.reply')} onClick={() => setReply(roomId, m.id)}>
                <CornerUpLeft className="size-4" />
              </IconButton>
            ) : null}
            <IconButton
              label={t('chat.copy')}
              onClick={() => void navigator.clipboard.writeText(m.content).then(() => toast.success(t('chat.copied')))}
            >
              <Copy className="size-4" />
            </IconButton>
            {isMe ? (
              <IconButton label={t('chat.edit')} onClick={() => setEditing(c.key)}>
                <Pencil className="size-4" />
              </IconButton>
            ) : null}
            {canDelete ? (
              <IconButton label={t('common.delete')} danger onClick={() => void remove()}>
                <Trash2 className="size-4" />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

function ReplyPreview({ roomId, workspaceId, replyToId }: { roomId: string; workspaceId: string; replyToId: string }): ReactNode {
  const target = useMessages((s) => s.rooms[roomId]?.items.find((c) => c.key === replyToId)?.msg);
  if (!target) return <div className="mb-0.5 text-[12px] italic text-faint">↪ {t('chat.replyMissing')}</div>;
  const snippet = toPlainText(parseMarkdown(target.content)).slice(0, 120) || '📎';
  return (
    <div className="mb-0.5 flex items-center gap-1 truncate text-[12px] text-muted">
      <CornerUpLeft className="size-3 shrink-0 -scale-x-100" />
      <span className="font-semibold">{memberName(workspaceId, target.authorId)}</span>
      <span className="truncate">{snippet}</span>
    </div>
  );
}

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }): ReactNode {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (text.trim()) onSave(text.trim());
    }
  };
  return (
    <div className="my-1">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={Math.min(10, text.split('\n').length)}
        maxLength={4000}
        className="w-full resize-none rounded-[var(--radius-control)] bg-input px-3 py-2 focus-visible:outline-none focus:ring-2 focus:ring-accent"
      />
      <div className="text-[11px] text-faint">{t('chat.editHint')}</div>
    </div>
  );
}

function isImage(f: FileMeta): boolean {
  return f.mime.startsWith('image/') && !!f.thumbnailUrl;
}

function Attachments({ files }: { files: FileMeta[] }): ReactNode {
  const open = useUi((s) => s.openDialog);
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {files.map((f) =>
        isImage(f) ? (
          <button
            key={f.id}
            type="button"
            onClick={() => open({ kind: 'image', fileId: f.id, name: f.name })}
            className="overflow-hidden rounded-[var(--radius-control)] bg-elev border border-line"
            style={
              f.width && f.height
                ? { width: Math.min(400, (f.width * Math.min(300, f.height)) / f.height), aspectRatio: `${f.width} / ${f.height}` }
                : { maxWidth: 400, maxHeight: 300 }
            }
          >
            <MediaImg path={thumbnailPath(f.id)} alt={f.name} loading="lazy" className="block size-full object-cover" draggable={false} />
          </button>
        ) : (
          <div key={f.id} className="flex w-[340px] items-center gap-3 rounded-[var(--radius-control)] border border-line bg-elev px-3 py-2.5">
            <FileText className="size-8 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-accent-text">{f.name}</div>
              <div className="text-[12px] text-faint">{fmtSize(f.size)}</div>
            </div>
            <IconButton
              label={t('chat.download')}
              onClick={() =>
                void platform.files.download({ fileId: f.id, name: f.name }).then(
                  () => toast.success(t('chat.downloaded', { name: f.name })),
                  (e: unknown) => toast.error(String(e)),
                )
              }
            >
              <Download className="size-5" />
            </IconButton>
          </div>
        ),
      )}
    </div>
  );
}

function Uploads({ uploads }: { uploads: PendingUpload[] }): ReactNode {
  return (
    <div className="mt-1 flex flex-col gap-1">
      {uploads.map((u) => (
        <div key={u.key} className="w-[340px] rounded-[var(--radius-control)] border border-line bg-elev px-3 py-2">
          <div className="flex justify-between text-[12px]">
            <span className="truncate">{u.name}</span>
            <span className="text-faint">{Math.round(u.progress * 100)}%</span>
          </div>
          <div className="mt-1 h-1 rounded-full bg-active">
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(u.progress * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
