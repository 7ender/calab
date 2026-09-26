import type { PermissionBits, Room } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { ArrowUp, Camera, Check, CornerUpLeft, FileText, Image as ImageIcon, Paperclip, Pencil, Smile, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { IconButton, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmtSize } from '../../lib/format';
import { MENTION_EVENT, type MentionRequest } from './mentionRequest';
import { applyMention, exactNames, filterCandidates, filterSpecial, fromWire, mentionQuery, toWire } from '../../lib/mentions';
import { can } from '../../lib/permissions';
import { useMobile } from '../../lib/mobile';
import { MAX_ATTACHMENTS, MAX_CONTENT, editMessage, loadPresent, notifyTyping, sendMessage, type OutgoingFile } from '../../services/chat';
import { useMessages } from '../../stores/messages';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { EmojiPicker } from './EmojiPicker';
import { MentionPopover, optionKey, useMentionables, type MentionOption } from './MentionPopover';
import { previewText } from './mentionText';
import { roomLabel } from './roomLabel';
import { menuBox, menuItem } from './MessageMenu';

const drafts = new Map<string, string>();
/** Per-draft mentions picked in the popover: shown name → user id (the wire format is `@<id>`). */
const draftMentions = new Map<string, Map<string, string>>();
const NO_MENTIONS: ReadonlyMap<string, string> = new Map();
/** Field grows up to 6 lines (15 px text on a 20 px line — integer line boxes keep layout pixel-exact). */
const MAX_FIELD_H = 6 * 20 + 16;

export function toOutgoing(f: File): OutgoingFile {
  const name = f.name || `image-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  return { file: f, name, ...(f.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(f) } : {}) };
}

/** Telegram-like composer (docs/09 #37): rounded field, 📎 left, emoji + round send right. */
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
  const imageInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const mobile = useMobile();
  const pendingCaret = useRef<number | null>(null);
  const replyTo = useUi((s) => s.replyTo[room.id]);
  const setReply = useUi((s) => s.setReply);
  const editing = useUi((s) => s.editing);
  const setEditing = useUi((s) => s.setEditing);
  const replyMsg = useMessages((s) => (replyTo ? s.rooms[room.id]?.items.find((c) => c.key === replyTo)?.msg : undefined));
  const editMsg = useMessages((s) => (editing ? s.rooms[room.id]?.items.find((c) => c.key === editing)?.msg : undefined));
  const me = useSession((s) => s.me?.user?.id ?? '');
  const canSend = can(perms, 'SEND_MESSAGES');
  const canAttach = can(perms, 'ATTACH_FILES');
  // Edit mode uses the same field: the draft is kept aside and comes back afterwards
  // (derived during render when the edited message changes — no effect cascade).
  const [editTrack, setEditTrack] = useState<string | undefined>(undefined);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState<{ text: string; mentions: ReadonlyMap<string, string> } | null>(null);
  // Mentions picked in the field (name → id); `@<id>` is what goes over the wire.
  const [mentions, setMentions] = useState<ReadonlyMap<string, string>>(() => draftMentions.get(room.id) ?? NO_MENTIONS);
  if (editMsg?.id !== editTrack) {
    setEditTrack(editMsg?.id);
    if (editMsg) {
      if (draftBeforeEdit === null) setDraftBeforeEdit({ text, mentions });
      // The field shows names: `@<id>` → `@Имя` for members known here.
      const w = fromWire(editMsg.content, (id) => (useWorkspaces.getState().byId[workspaceId]?.members[id] ? memberName(workspaceId, id) : undefined));
      setText(w.text);
      setMentions(w.mentions);
    } else if (draftBeforeEdit !== null) {
      setText(draftBeforeEdit.text);
      setMentions(draftBeforeEdit.mentions);
      setDraftBeforeEdit(null);
    }
  }

  useEffect(() => {
    if (draftBeforeEdit !== null) return;
    drafts.set(room.id, text);
    draftMentions.set(room.id, new Map(mentions));
  }, [room.id, text, mentions, draftBeforeEdit]);

  // ---- mention autocomplete (docs/05, «Упоминания»)
  const listId = useId();
  const mentionables = useMentionables(workspaceId, room, me);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const mq = mentionQuery(text, caret);
  const options: MentionOption[] =
    mq && mq.start !== dismissed
      ? [
          ...filterCandidates(mq.query, mentionables.candidates).map((c): MentionOption => ({ kind: 'member', c, guest: mentionables.guests.has(c.id) })),
          // @everyone / @here only with MENTION_EVERYONE in this room (guests never have it, ADR-0016).
          ...(!can(perms, 'MENTION_EVERYONE') ? [] : filterSpecial(mq.query).map((v): MentionOption => ({ kind: 'special', v }))),
        ]
      : [];
  const popover = options.length > 0;
  const selIdx = Math.min(sel, Math.max(0, options.length - 1));
  const [queryTrack, setQueryTrack] = useState<string | null>(null);
  const queryKey = mq ? `${mq.start}:${mq.query}` : null;
  if (queryKey !== queryTrack) {
    setQueryTrack(queryKey);
    setSel(0);
  }
  const syncCaret = (): void => setCaret(ref.current?.selectionStart ?? 0);

  const pick = (o: MentionOption): void => {
    if (!mq) return;
    const name = o.kind === 'member' ? o.c.name : o.v;
    const next = applyMention(text, mq.start, caret, name);
    setText(next.text);
    setCaret(next.caret);
    if (o.kind === 'member') setMentions((m) => new Map(m).set(name, o.c.id));
    // Placed right after the re-render (not in a frame callback: fast typing would land before it).
    pendingCaret.current = next.caret;
  };

  // «Упомянуть» from a member menu (mentionRequest.ts): append `@name ` and focus the field.
  useEffect(() => {
    const onMention = (e: Event): void => {
      const d = (e as CustomEvent<MentionRequest>).detail;
      setText((cur) => {
        const next = `${cur && !/\s$/.test(cur) ? `${cur} ` : cur}@${d.name} `;
        pendingCaret.current = next.length;
        return next;
      });
      setMentions((m) => new Map(m).set(d.name, d.userId));
      ref.current?.focus();
    };
    window.addEventListener(MENTION_EVENT, onMention);
    return () => window.removeEventListener(MENTION_EVENT, onMention);
  }, []);

  /** Field text → wire format: picked names and exact member names become `@<id>`. */
  const wire = (content: string): string => toWire(content, new Map([...exactNames(mentionables.all), ...mentions]));

  useEffect(() => {
    if (!editTrack) return;
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [editTrack]);

  useEffect(() => {
    ref.current?.focus();
  }, [room.id, replyTo]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.focus();
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_FIELD_H)}px`;
  }, [text]);

  const cancelEdit = (): void => setEditing(null);

  const send = (): void => {
    const content = wire(text.trim());
    if (content.length > MAX_CONTENT) return;
    if (editMsg) {
      if (!content && editMsg.attachments.length === 0) return;
      if (content !== editMsg.content) void editMessage(editMsg.id, content);
      cancelEdit();
      return;
    }
    if (!content && files.length === 0) return;
    // Viewing older history: go back to the present so the new message is visible.
    if (useMessages.getState().rooms[room.id]?.hasMoreAfter) void loadPresent(room.id);
    void sendMessage(workspaceId, room.id, content, files, replyTo);
    setText('');
    setMentions(NO_MENTIONS);
    setFiles([]);
    setReply(room.id, undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popover && !e.nativeEvent.isComposing) {
      const o = options[selIdx];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((selIdx + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (o) pick(o);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(mq?.start ?? null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
      return;
    }
    if (e.key === 'Escape') {
      if (editMsg) {
        e.preventDefault();
        cancelEdit();
      } else if (replyTo) {
        e.preventDefault();
        setReply(room.id, undefined);
      }
      return;
    }
    if (e.key === 'ArrowUp' && !text && !editMsg) {
      // Edit my last message (Telegram / Discord habit).
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
    if (imgs.length && canAttach && !editMsg) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  const insert = (s: string): void => {
    const el = ref.current;
    if (!el) {
      setText((v) => v + s);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    setCaret(start + s.length);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + s.length, start + s.length);
    });
  };

  if (!canSend) {
    return <div className="mx-4 my-3 rounded-[var(--radius-card)] bg-hover px-4 py-3 text-body text-muted">{t('chat.noSend')}</div>;
  }

  const hasContent = !!text.trim() || (!editMsg && files.length > 0);
  const placeholder = t('chat.placeholderIn', { room: roomLabel(room) });
  const bar = editMsg ? (
    <ContextBar
      icon={<Pencil className="size-4" aria-hidden />}
      title={t('chat.editing')}
      text={snippet(workspaceId, editMsg.content)}
      onClose={cancelEdit}
    />
  ) : replyMsg ? (
    <ContextBar
      icon={<CornerUpLeft className="size-4" aria-hidden />}
      title={t('chat.replyTo', { name: memberName(workspaceId, replyMsg.authorId) })}
      text={snippet(workspaceId, replyMsg.content) || t('chat.attachment')}
      onClose={() => setReply(room.id, undefined)}
    />
  ) : null;

  return (
    <div className="px-4 pb-3 pt-2 mobile:px-2 mobile:pb-2">
      {bar}
      {files.length > 0 && !editMsg ? <AttachmentGrid files={files} setFiles={setFiles} /> : null}
      <div className="relative flex items-end gap-2">
        {popover ? <MentionPopover id={listId} options={options} sel={selIdx} onPick={pick} onHover={setSel} /> : null}
        <div
          data-focus-box
          className="flex min-h-10 min-w-0 flex-1 items-end rounded-[20px] border border-line bg-elev px-1 shadow-[var(--shadow-card)] focus-within:border-accent"
        >
          {canAttach && !editMsg ? (
            <Dropdown.Root modal={false}>
              <Tip label={t('chat.attach')}>
                <Dropdown.Trigger asChild>
                  <IconButton tip={false} label={t('chat.attach')} className="mb-1 rounded-full" disabled={files.length >= MAX_ATTACHMENTS}>
                    <Paperclip className="size-5" />
                  </IconButton>
                </Dropdown.Trigger>
              </Tip>
              <Dropdown.Portal>
                <Dropdown.Content side="top" align="start" sideOffset={8} className={menuBox}>
                  <Dropdown.Item className={menuItem} onSelect={() => imageInput.current?.click()}>
                    <ImageIcon className="size-4" aria-hidden /> {t('chat.attachImage')}
                  </Dropdown.Item>
                  <Dropdown.Item className={menuItem} onSelect={() => fileInput.current?.click()}>
                    <FileText className="size-4" aria-hidden /> {t('chat.attachFile')}
                  </Dropdown.Item>
                  {mobile ? (
                    // Phone layout (ADR-0021): straight to the camera (`capture`), next to the gallery and files.
                    <Dropdown.Item className={menuItem} onSelect={() => cameraInput.current?.click()}>
                      <Camera className="size-4" aria-hidden /> {t('mobile.takePhoto')}
                    </Dropdown.Item>
                  ) : null}
                </Dropdown.Content>
              </Dropdown.Portal>
            </Dropdown.Root>
          ) : (
            <span className="w-2" />
          )}
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
          {mobile ? (
            <input
              ref={cameraInput}
              type="file"
              accept="image/*,video/*"
              capture="environment"
              hidden
              data-testid="composer-camera-input"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          ) : null}
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <textarea
            ref={ref}
            value={text}
            rows={1}
            maxLength={MAX_CONTENT}
            placeholder={placeholder}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
              if (e.target.value && !editMsg) notifyTyping(room.id);
            }}
            onSelect={syncCaret}
            onBlur={() => setDismissed(mq?.start ?? null)}
            onFocus={() => setDismissed(null)}
            aria-autocomplete="list"
            aria-controls={popover ? listId : undefined}
            aria-activedescendant={popover && options[selIdx] ? `${listId}-${optionKey(options[selIdx])}` : undefined}
            onKeyDown={onKey}
            onPaste={onPaste}
            aria-label={placeholder}
            className="selectable min-h-[38px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[9px] text-list leading-5 placeholder:text-faint focus:outline-none focus-visible:outline-none"
            style={{ maxHeight: MAX_FIELD_H }}
          />
          <EmojiPicker onPick={insert} label={t('chat.emoji')}>
            <IconButton tip={false} label={t('chat.emoji')} className="mb-1 rounded-full">
              <Smile className="size-5" />
            </IconButton>
          </EmojiPicker>
        </div>
        {hasContent ? (
          <Tip label={editMsg ? t('common.save') : t('chat.send')} shortcut="↵">
            <button
              type="button"
              onClick={send}
              aria-label={editMsg ? t('common.save') : t('chat.send')}
              className="anim-pop mb-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-fg shadow-[var(--shadow-card)] hover:brightness-110 active:brightness-95"
            >
              {editMsg ? <Check className="size-5" strokeWidth={2.25} /> : <ArrowUp className="size-5" strokeWidth={2.25} />}
            </button>
          </Tip>
        ) : null}
      </div>
      {text.length > MAX_CONTENT - 200 ? (
        <div className="mt-1 text-right text-micro text-warn">
          {text.length}/{MAX_CONTENT}
        </div>
      ) : null}
    </div>
  );
}

function snippet(workspaceId: string, content: string): string {
  return previewText(workspaceId, content).slice(0, 160);
}

/** Reply / edit strip above the field (accent bar, title, snippet, ×). */
function ContextBar({ icon, title, text, onClose }: { icon: ReactNode; title: string; text: string; onClose: () => void }): ReactNode {
  return (
    <div className="mb-2 flex items-center gap-3 pl-2">
      <span className="text-accent-text">{icon}</span>
      <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
        <div className="truncate text-body font-semibold text-accent-text">{title}</div>
        <div className="truncate text-body text-muted">{text}</div>
      </div>
      <IconButton label={t('common.cancel')} size="sm" className="rounded-full" onClick={onClose}>
        <X className="size-4" />
      </IconButton>
    </div>
  );
}

function AttachmentGrid({ files, setFiles }: { files: OutgoingFile[]; setFiles: (f: OutgoingFile[]) => void }): ReactNode {
  return (
    <div className="mb-2 flex max-h-[200px] flex-wrap gap-2 overflow-y-auto" data-testid="composer-attachments">
      {files.map((f, i) => (
        <div
          key={`${f.name}-${i}`}
          className={cx(
            'relative shrink-0 overflow-hidden rounded-[var(--radius-card)] border border-line bg-elev',
            f.previewUrl ? 'size-20' : 'flex h-20 w-44 items-center gap-2 px-2',
          )}
          title={f.name}
        >
          {f.previewUrl ? (
            <img src={f.previewUrl} alt={f.name} className="size-full object-cover" />
          ) : (
            <>
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-strong text-accent-fg">
                <FileText className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-body font-medium">{f.name}</span>
                <span className="block text-caption text-muted">{fmtSize(f.file.size)}</span>
              </span>
            </>
          )}
          <Tip label={t('chat.removeAttachment', { name: f.name })}>
            <button
              type="button"
              className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-[rgb(0_0_0/55%)] text-[color:var(--color-on-accent)] hover:bg-[rgb(0_0_0/70%)]"
              aria-label={t('chat.removeAttachment', { name: f.name })}
              onClick={() => setFiles(files.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </button>
          </Tip>
        </div>
      ))}
    </div>
  );
}
