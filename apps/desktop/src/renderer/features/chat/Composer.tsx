import type { PermissionBits, Room } from '@calaba/protocol';
import { FileText, Paperclip, SendHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmtSize } from '../../lib/format';
import { can } from '../../lib/permissions';
import { MAX_ATTACHMENTS, MAX_CONTENT, notifyTyping, sendMessage, type OutgoingFile } from '../../services/chat';
import { useMessages } from '../../stores/messages';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { memberName } from '../../stores/workspaces';

const drafts = new Map<string, string>();

export function toOutgoing(f: File): OutgoingFile {
  const name = f.name || `image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  return { file: f, name, ...(f.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(f) } : {}) };
}

export function Composer({
  workspaceId,
  room,
  perms,
  files,
  setFiles,
  addFiles,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  files: OutgoingFile[];
  setFiles: (f: OutgoingFile[]) => void;
  addFiles: (f: File[]) => void;
}): ReactNode {
  const [text, setText] = useState(() => drafts.get(room.id) ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replyTo = useUi((s) => s.replyTo[room.id]);
  const setReply = useUi((s) => s.setReply);
  const setEditing = useUi((s) => s.setEditing);
  const replyMsg = useMessages((s) => (replyTo ? s.rooms[room.id]?.items.find((c) => c.key === replyTo)?.msg : undefined));
  const me = useSession((s) => s.me?.user?.id ?? '');
  const canSend = can(perms, 'SEND_MESSAGES');
  const canAttach = can(perms, 'ATTACH_FILES');

  useEffect(() => {
    drafts.set(room.id, text);
  }, [room.id, text]);

  useEffect(() => {
    ref.current?.focus();
  }, [room.id, replyTo]);

  // Autosize up to ~12 lines.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const send = (): void => {
    const content = text.trim();
    if ((!content && files.length === 0) || content.length > MAX_CONTENT) return;
    void sendMessage(workspaceId, room.id, content, files, replyTo);
    setText('');
    setFiles([]);
    setReply(room.id, undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape' && replyTo) setReply(room.id, undefined);
    if (e.key === 'ArrowUp' && !text) {
      // Edit my last message (Discord habit).
      const items = useMessages.getState().rooms[room.id]?.items ?? [];
      const mine = [...items].reverse().find((c) => c.status === 'sent' && c.msg.authorId === me);
      if (mine) {
        e.preventDefault();
        setEditing(mine.key);
      }
    }
  };

  const onPaste = (e: ClipboardEvent): void => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length && canAttach) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  if (!canSend) {
    return <div className="mx-4 my-3 rounded-[var(--radius-card)] bg-hover px-4 py-3 text-[13px] text-muted">{t('chat.noSend')}</div>;
  }

  return (
    <div className="px-4 pt-3">
      {replyMsg ? (
        <div className="flex items-center justify-between rounded-t-[var(--radius-card)] border border-b-0 border-line bg-hover px-3 py-1.5 text-[12px] text-muted">
          <span className="truncate">
            {t('chat.replyingTo')} <span className="font-semibold text-fg">{memberName(workspaceId, replyMsg.authorId)}</span>
          </span>
          <button type="button" onClick={() => setReply(room.id, undefined)} aria-label={t('common.cancel')}>
            <X className="size-4" />
          </button>
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={cx('flex gap-2 overflow-x-auto border border-b-0 border-line bg-elev px-3 pt-3', !replyMsg && 'rounded-t-[var(--radius-card)]')}>
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="relative w-36 shrink-0 rounded-md bg-side p-2">
              {f.previewUrl ? (
                <img src={f.previewUrl} alt="" className="h-20 w-full rounded object-cover" />
              ) : (
                <div className="grid h-20 place-items-center">
                  <FileText className="size-8 text-accent" />
                </div>
              )}
              <div className="mt-1 truncate text-[12px]">{f.name}</div>
              <div className="text-[11px] text-faint">{fmtSize(f.file.size)}</div>
              <button
                type="button"
                className="absolute right-1 top-1 rounded bg-main/80 p-0.5 text-danger"
                aria-label={t('common.delete')}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
              >
                <X className="size-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className={cx('flex items-end gap-1 border border-line bg-elev px-1.5 py-1 shadow-[var(--shadow-card)]', replyMsg || files.length ? 'rounded-b-[var(--radius-card)]' : 'rounded-[var(--radius-card)]')}>
        {canAttach ? (
          <>
            <IconButton label={t('chat.attach')} onClick={() => fileInput.current?.click()} disabled={files.length >= MAX_ATTACHMENTS}>
              <Paperclip className="size-5" />
            </IconButton>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        ) : null}
        <textarea
          ref={ref}
          value={text}
          rows={1}
          maxLength={MAX_CONTENT}
          placeholder={t('chat.placeholder', { name: room.name })}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) notifyTyping(room.id);
          }}
          onKeyDown={onKey}
          onPaste={onPaste}
          aria-label={t('chat.placeholder', { name: room.name })}
          className="selectable max-h-[280px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug placeholder:text-faint focus:outline-none focus-visible:outline-none"
        />
        <IconButton label={t('chat.send')} onClick={send} disabled={!text.trim() && files.length === 0}>
          <SendHorizontal className="size-5" />
        </IconButton>
      </div>
      {text.length > MAX_CONTENT - 200 ? (
        <div className="mt-1 text-right text-[11px] text-warn">
          {text.length}/{MAX_CONTENT}
        </div>
      ) : null}
    </div>
  );
}
