import * as DialogP from '@radix-ui/react-dialog';
import { RoomType, type Message, type Room, type WorkspaceMember } from '@calaba/protocol';
import { Hash, Search, Volume2, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Spinner, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmtTime, toDate } from '../../lib/format';
import { voice } from '../../services/voice';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { fmtDayLabel } from '../chat/MessageBubble';
import { previewText } from '../chat/mentionText';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { roomLabel } from '../chat/roomLabel';

type Item =
  | { kind: 'room'; id: string; room: Room }
  | { kind: 'member'; id: string; member: WorkspaceMember }
  | { kind: 'message'; id: string; msg: Message };

const MAX_ROOMS_QUERY = 6;
const MAX_MEMBERS = 5;

/**
 * ⌘/Ctrl+K — global search (docs/09 #3): rooms of every workspace, members and messages of the
 * active one (server FTS). Choosing a member filters messages by that author.
 */
export function QuickSwitcher({ onClose }: { onClose: () => void }): ReactNode {
  const rooms = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  const activeWs = useUi((s) => s.activeWorkspaceId);
  const openRoom = useUi((s) => s.openRoom);
  const [q, setQ] = useState('');
  const [author, setAuthor] = useState<WorkspaceMember | null>(null);
  const [sel, setSel] = useState(0);
  // Server results tagged with the request they answer (no state reset inside effects).
  const [found, setFound] = useState<{ key: string; list: Message[] } | null>(null);
  const needle = q.trim().toLowerCase();

  const roomItems = useMemo(() => {
    if (author) return [];
    const list = Object.values(rooms)
      .filter((r) => workspaces[r.workspaceId])
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      // The active workspace first, then by name.
      .sort((a, b) => Number(b.workspaceId === activeWs) - Number(a.workspaceId === activeWs) || a.name.localeCompare(b.name, 'ru'));
    return list.slice(0, needle ? MAX_ROOMS_QUERY : 50);
  }, [needle, rooms, workspaces, activeWs, author]);

  const memberItems = useMemo(() => {
    if (!needle || author || !activeWs) return [];
    const ms = Object.values(workspaces[activeWs]?.members ?? {});
    return ms
      .filter((m) => [m.nickname, m.user?.displayName ?? ''].some((n) => n.toLowerCase().includes(needle)))
      .slice(0, MAX_MEMBERS);
  }, [needle, author, activeWs, workspaces]);

  // Messages: server full-text search in the active workspace, debounced.
  const text = q.trim();
  const searchKey = text && activeWs ? `${activeWs}|${author?.user?.id ?? ''}|${text}` : '';
  useEffect(() => {
    if (!searchKey || !activeWs) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      api.messages
        .searchWorkspace(activeWs, { q: text, limit: 20, ...(author?.user ? { author_id: author.user.id } : {}) }, ctl.signal)
        .then(
          (r) => setFound({ key: searchKey, list: r.messages }),
          () => {
            if (!ctl.signal.aborted) setFound({ key: searchKey, list: [] });
          },
        );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [searchKey, text, activeWs, author]);
  const messages = searchKey && found?.key === searchKey ? found.list : null;
  const busy = !!searchKey && found?.key !== searchKey;

  const items: Item[] = useMemo(
    () => [
      ...roomItems.map((room): Item => ({ kind: 'room', id: `r-${room.id}`, room })),
      ...memberItems.map((member): Item => ({ kind: 'member', id: `u-${member.user?.id ?? ''}`, member })),
      ...(messages ?? []).map((msg): Item => ({ kind: 'message', id: `m-${msg.id}`, msg })),
    ],
    [roomItems, memberItems, messages],
  );
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  const go = (i: number): void => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'room') {
      const r = it.room;
      openRoom(r.workspaceId, r.id);
      if (r.type === RoomType.VOICE && useVoice.getState().roomId !== r.id) void voice.join(r.id, r.workspaceId);
      onClose();
    } else if (it.kind === 'member') {
      setAuthor(it.member);
      setQ('');
      setSel(0);
    } else {
      const r = rooms[it.msg.roomId];
      if (!r) return;
      openRoom(r.workspaceId, r.id);
      useChatView.getState().requestJump(r.id, it.msg.id);
      onClose();
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(items.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(cur);
    } else if (e.key === 'Backspace' && !q && author) {
      setAuthor(null);
    }
  };

  const section = (kind: Item['kind']): string =>
    kind === 'room' ? t('search.rooms') : kind === 'member' ? t('search.members') : t('search.messages');

  return (
    <DialogP.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogP.Portal>
        <DialogP.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content aria-modal="true"
          aria-label={t('search.title')}
          data-layout-anchor="top" // Spotlight-like: anchored near the top, not centred
          className="mat-sheet anim-in fixed left-1/2 top-[14vh] z-[var(--z-modal)] flex max-h-[70vh] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-[var(--radius-panel)] focus:outline-none"
        >
          <DialogP.Title className="sr-only">{t('search.title')}</DialogP.Title>
          <DialogP.Description className="sr-only">{t('search.hint')}</DialogP.Description>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
            {author ? (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent-strong py-0.5 pl-2 pr-1 text-caption font-medium text-accent-fg">
                {t('search.from', { name: memberName(activeWs, author.user?.id ?? '') })}
                <Tip label={t('search.clearFrom')}>
                  <button type="button" aria-label={t('search.clearFrom')} className="grid size-4 place-items-center rounded-full hover:bg-[rgb(255_255_255/20%)]" onClick={() => setAuthor(null)}>
                    <X className="size-3" />
                  </button>
                </Tip>
              </span>
            ) : null}
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={onKey}
              role="combobox"
              aria-expanded
              aria-controls="quick-switcher-list"
              aria-activedescendant={items[cur] ? `qs-${items[cur].id}` : undefined}
              placeholder={t('search.placeholder')}
              aria-label={t('search.placeholder')}
              className="h-12 min-w-0 flex-1 bg-transparent text-headline text-fg placeholder:text-faint focus:outline-none focus-visible:outline-none"
            />
            {busy ? <Spinner className="size-4" /> : null}
          </div>
          <ul id="quick-switcher-list" role="listbox" aria-label={t('search.title')} className="min-h-0 overflow-y-auto p-1.5">
            {items.length === 0 ? (
              <li role="presentation" className="px-3 py-6 text-center text-body text-muted">
                {busy ? t('search.searching') : author && !q.trim() ? t('search.memberHint') : t('search.empty')}
              </li>
            ) : null}
            {items.map((it, i) => (
              <Fragment key={it.id}>
                {needle && (i === 0 || items[i - 1]?.kind !== it.kind) ? (
                  <li role="presentation" className="px-3 pb-1 pt-2 text-caption font-semibold text-muted">
                    {section(it.kind)}
                  </li>
                ) : null}
                <li
                  id={`qs-${it.id}`}
                  role="option"
                  aria-selected={i === cur}
                  onMouseMove={() => i !== cur && setSel(i)}
                  onClick={() => go(i)}
                  className={cx(
                    'flex w-full cursor-default items-center gap-2 rounded-[var(--radius-control)] px-3 text-left text-body',
                    it.kind === 'message' ? 'py-1.5' : 'h-9',
                    i === cur ? 'bg-accent-strong text-accent-fg' : 'text-fg',
                  )}
                >
                  <Row it={it} selected={i === cur} q={q.trim()} workspaceName={(id) => workspaces[id]?.ws.name ?? ''} rooms={rooms} />
                </li>
              </Fragment>
            ))}
          </ul>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

function Row({
  it,
  selected,
  q,
  workspaceName,
  rooms,
}: {
  it: Item;
  selected: boolean;
  q: string;
  workspaceName: (id: string) => string;
  rooms: Record<string, Room>;
}): ReactNode {
  const sub = cx('shrink-0 truncate text-caption', selected ? 'text-accent-fg' : 'text-muted');
  if (it.kind === 'room') {
    const r = it.room;
    const Icon = r.type === RoomType.VOICE ? Volume2 : Hash;
    return (
      <>
        <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={r.name} q={q} selected={selected} />
        </span>
        <span className={sub}>{workspaceName(r.workspaceId)}</span>
      </>
    );
  }
  if (it.kind === 'member') {
    const u = it.member.user;
    const name = it.member.nickname || u?.displayName || '';
    return (
      <>
        <Avatar userId={u?.id ?? ''} name={name} fileId={u?.avatarFileId || undefined} size={20} />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={name} q={q} selected={selected} />
        </span>
        <span className={sub}>{t('search.memberHint')}</span>
      </>
    );
  }
  const m = it.msg;
  const room = rooms[m.roomId];
  const d = toDate(m.createdAt);
  const wsId = room?.workspaceId ?? null;
  const text = previewText(wsId, m.content) || t('chat.attachment');
  const author = memberName(wsId, m.authorId);
  const user = useWorkspaces.getState().users[m.authorId];
  return (
    <>
      <Avatar userId={m.authorId} name={author} fileId={user?.avatarFileId || undefined} size={28} className="self-start" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-semibold">{author}</span>
          <span className={sub}>
            {room ? `${roomLabel(room)} · ` : ''}
            {fmtDayLabel(d)}, {fmtTime(d)}
          </span>
        </span>
        <span className="line-clamp-2 break-words">
          <Highlight text={snippetAround(text, q)} q={q} selected={selected} />
        </span>
      </span>
    </>
  );
}

/** ~140 characters of context around the first match. */
export function snippetAround(text: string, q: string, span = 140): string {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase().split(/\s+/)[0] ?? '') : -1;
  if (i < 0 || text.length <= span) return text.slice(0, span);
  const start = Math.max(0, Math.min(i - 40, text.length - span));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + span)}${start + span < text.length ? '…' : ''}`;
}

/** Hits: 600 weight + accent text (on the selected row the accent fill already marks it: inherit). */
function Highlight({ text, q, selected }: { text: string; q: string; selected: boolean }): ReactNode {
  const parts = splitHits(text, searchWords(q));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className={cx('bg-transparent font-semibold', selected ? 'text-inherit' : 'text-accent-text')}>
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
