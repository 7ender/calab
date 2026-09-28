import * as DialogP from '@radix-ui/react-dialog';
import { RoomType, type Message, type Room, type WorkspaceMember } from '@calaba/protocol';
import { Hash, MessageSquare, Phone, Search, Volume2, X } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton, Spinner, Tip, cx } from '../../components/ui';
import { getLocale, t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { fmt, toDate } from '../../lib/format';
import { voice } from '../../services/voice';
import { can, roomPerms } from '../../lib/permissions';
import { joinOutcome } from '../../lib/voiceEntry';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { HOME, sortedDms, useDms } from '../../stores/dms';
import { useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, rolesOf, useWorkspaces } from '../../stores/workspaces';
import { customLook } from '../../lib/roles';
import { RoleMark, roleTextClass, roleTextStyle } from '../people/MemberBits';
import { useChatView } from '../chat/chatView';
import { previewText } from '../chat/mentionText';
import { searchWords, splitHits } from '../../lib/markdown/highlight';
import { roomLabel } from '../chat/roomLabel';
import { systemPreview } from '../../lib/recording';
import { keyAction, rowActions, type SwitcherAction, type SwitcherRowKind } from './quickSwitcherActions';

type Item =
  | { kind: 'dm'; id: string; roomId: string; peerId: string; name: string }
  | { kind: 'room'; id: string; room: Room }
  | { kind: 'member'; id: string; member: WorkspaceMember }
  | { kind: 'message'; id: string; msg: Message };

const MAX_ROOMS_QUERY = 6;
const MAX_DMS = 5;
const MAX_MEMBERS = 5;

/**
 * ⌘/Ctrl+K — global search (docs/09 #3): DMs by the peer's name (ADR-0020), rooms of every
 * workspace, members and messages of the active one (server FTS). Choosing a member filters
 * messages by that author.
 */
export function QuickSwitcher({ onClose, initialQuery = '' }: { onClose: () => void; initialQuery?: string }): ReactNode {
  const rooms = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  // «Личные» is not a workspace: no members / message search there.
  const activeWs = useUi((s) => (s.activeWorkspaceId && s.activeWorkspaceId !== HOME ? s.activeWorkspaceId : null));
  const openRoom = useUi((s) => s.openRoom);
  const dms = useDms((s) => s.byRoom);
  const users = useWorkspaces((s) => s.users);
  const [q, setQ] = useState(initialQuery);
  const [author, setAuthor] = useState<WorkspaceMember | null>(null);
  const [sel, setSel] = useState(0);
  // Server results tagged with the request they answer (no state reset inside effects).
  const [found, setFound] = useState<{ key: string; list: Message[] } | null>(null);
  const needle = q.trim().toLowerCase();

  const home = useUi((s) => s.activeWorkspaceId === HOME);
  const dmItems = useMemo(() => {
    // Without a query: recent DMs only in «Личные» (a workspace lists its rooms first).
    if (author || (!needle && !home)) return [];
    return sortedDms(dms)
      .map((e) => ({ ...e, name: memberName(null, e.peerId) }))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .slice(0, MAX_DMS);
    // users: a peer's renamed profile re-filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, dms, users, author, home]);

  const roomItems = useMemo(() => {
    if (author) return [];
    const list = Object.values(rooms)
      .filter((r) => workspaces[r.workspaceId])
      .filter((r) => !needle || r.name.toLowerCase().includes(needle))
      // The active workspace first, then by name.
      .sort((a, b) => Number(b.workspaceId === activeWs) - Number(a.workspaceId === activeWs) || a.name.localeCompare(b.name, getLocale()));
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
      ...dmItems.map((e): Item => ({ kind: 'dm', id: `d-${e.roomId}`, roomId: e.roomId, peerId: e.peerId, name: e.name })),
      ...roomItems.map((room): Item => ({ kind: 'room', id: `r-${room.id}`, room })),
      ...memberItems.map((member): Item => ({ kind: 'member', id: `u-${member.user?.id ?? ''}`, member })),
      ...(messages ?? []).map((msg): Item => ({ kind: 'message', id: `m-${msg.id}`, msg })),
    ],
    [dmItems, roomItems, memberItems, messages],
  );
  const cur = Math.min(sel, Math.max(0, items.length - 1));
  // Grid row of each result (a section header takes the row above it).
  const gridRows = useMemo(() => {
    let r = 0;
    return items.map((it, i) => {
      if (needle && (i === 0 || items[i - 1]?.kind !== it.kind)) r += 1;
      return (r += 1);
    });
  }, [items, needle]);

  const go = (i: number, action?: SwitcherAction): void => {
    const it = items[i];
    if (!it) return;
    const act = action ?? rowActions(rowKind(it, canConnectNow(it)))[0];
    if (it.kind === 'dm') {
      openRoom(HOME, it.roomId);
      onClose();
    } else if (it.kind === 'room') {
      const r = it.room;
      openRoom(r.workspaceId, r.id);
      // «Подключиться» = a click on the room in the sidebar (same rights / limit checks);
      // «Открыть чат» only opens its feed — a call elsewhere stays as it is (docs/09 #14, #66).
      if (act === 'join') joinVoice(r);
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
  // Stable callbacks for the memoized rows: the latest go() through a ref.
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  const pick = useCallback((i: number, action?: SwitcherAction) => goRef.current(i, action), []);
  const hover = useCallback((i: number) => setSel(i), []);

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(items.length - 1, cur + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, cur - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const it = items[cur];
      if (it) go(cur, keyAction(rowKind(it, canConnectNow(it)), e));
    } else if (e.key === 'Backspace' && !q && author) {
      setAuthor(null);
    }
  };

  const section = (kind: Item['kind']): string =>
    kind === 'dm' ? t('search.dms') : kind === 'room' ? t('search.rooms') : kind === 'member' ? t('search.members') : t('search.messages');

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
              // Pre-filled from the header field: the caret goes after the typed text.
              onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
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
          {/* A two-column grid: the listbox (display: contents) fills column 1 with its options;
              each option's actions / Enter hint sit in column 2 on the same grid row — outside
              the listbox, whose children may only be options (docs/09 #66). */}
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_auto] content-start overflow-y-auto p-1.5">
            <ul id="quick-switcher-list" role="listbox" aria-label={t('search.title')} className="contents">
              {items.length === 0 ? (
                <li role="presentation" className="col-span-full px-3 py-6 text-center text-body text-muted">
                  {busy ? t('search.searching') : author && !q.trim() ? t('search.memberHint') : t('search.empty')}
                </li>
              ) : null}
              {items.map((it, i) => (
                <Fragment key={it.id}>
                  {needle && (i === 0 || items[i - 1]?.kind !== it.kind) ? (
                    <li role="presentation" className="col-span-full px-3 pb-1 pt-2 text-caption font-semibold text-muted" style={{ gridRow: (gridRows[i] ?? 1) - 1 }}>
                      {section(it.kind)}
                    </li>
                  ) : null}
                  <SwitcherOption
                    it={it}
                    index={i}
                    row={gridRows[i] ?? 1}
                    selected={i === cur}
                    q={q.trim()}
                    workspaceName={it.kind === 'room' ? (workspaces[it.room.workspaceId]?.ws.name ?? '') : ''}
                    rooms={rooms}
                    onPick={pick}
                    onHover={hover}
                  />
                </Fragment>
              ))}
            </ul>
            <div className="contents">
              {items.map((it, i) => (
                <SwitcherActions key={it.id} it={it} index={i} row={gridRows[i] ?? 1} selected={i === cur} onPick={pick} onHover={hover} />
              ))}
            </div>
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** My CONNECT in a voice room (read at the moment of the action). */
function canConnectNow(it: Item): boolean {
  if (it.kind !== 'room' || it.room.type !== RoomType.VOICE) return false;
  const me = useSession.getState().me?.user?.id ?? '';
  return can(roomPerms(rolesOf(useWorkspaces.getState().byId[it.room.workspaceId], me), me, it.room), 'CONNECT');
}

function rowKind(it: Item, canConnect: boolean): SwitcherRowKind {
  return it.kind === 'room' ? { kind: 'room', voice: it.room.type === RoomType.VOICE, canConnect } : { kind: it.kind };
}

/** The sidebar's click on a voice room (joinOutcome: CONNECT, the user limit, MOVE_MEMBERS). */
function joinVoice(r: Room): void {
  const entry = useWorkspaces.getState().byId[r.workspaceId];
  const me = useSession.getState().me?.user?.id ?? '';
  const perms = roomPerms(rolesOf(entry, me), me, r);
  const people = Object.values(entry?.voice ?? {}).filter((v) => v.roomId === r.id).length;
  const next = joinOutcome({
    inRoom: useVoice.getState().roomId === r.id,
    canConnect: can(perms, 'CONNECT'),
    canMove: can(perms, 'MOVE_MEMBERS'),
    people,
    limit: r.userLimit,
  });
  if (next === 'full') toast.info(t('shell.roomFull'));
  else if (next === 'join') void voice.join(r.id, r.workspaceId);
}

/** One result: the `option` (click = the primary action), column 1 of its grid row. */
const SwitcherOption = memo(function SwitcherOption({
  it,
  index,
  row,
  selected,
  q,
  workspaceName,
  rooms,
  onPick,
  onHover,
}: {
  it: Item;
  index: number;
  row: number;
  selected: boolean;
  q: string;
  workspaceName: string;
  rooms: Record<string, Room>;
  onPick: (i: number, action?: SwitcherAction) => void;
  onHover: (i: number) => void;
}): ReactNode {
  return (
    <li
      id={`qs-${it.id}`}
      role="option"
      aria-selected={selected}
      style={{ gridRow: row }}
      onMouseMove={selected ? undefined : () => onHover(index)}
      onClick={() => onPick(index)}
      className={cx(
        'col-start-1 flex min-w-0 cursor-default items-center gap-2 rounded-l-[var(--radius-row)] pl-3 pr-2 text-left text-body text-fg',
        it.kind === 'message' ? 'py-1.5' : 'h-9 mobile:h-12',
        selected && 'bg-active',
      )}
    >
      <RowBody it={it} q={q} workspaceName={workspaceName} rooms={rooms} />
    </li>
  );
});

/**
 * The row's right end (docs/09 #66), column 2 of its grid row: on the selected row (hover or
 * arrows) its action buttons, on the others the grey Enter hint. Phone: the buttons always,
 * 44 px, no hint.
 */
const SwitcherActions = memo(function SwitcherActions({
  it,
  index,
  row,
  selected,
  onPick,
  onHover,
}: {
  it: Item;
  index: number;
  row: number;
  selected: boolean;
  onPick: (i: number, action?: SwitcherAction) => void;
  onHover: (i: number) => void;
}): ReactNode {
  const canConnect = useCanConnect(it.kind === 'room' && it.room.type === RoomType.VOICE ? it.room : null);
  const actions = rowActions(rowKind(it, canConnect));
  const name = rowName(it);
  return (
    <div
      style={{ gridRow: row }}
      onMouseMove={selected ? undefined : () => onHover(index)}
      className={cx('col-start-2 flex items-center justify-end gap-1 rounded-r-[var(--radius-row)] pr-1.5', selected && 'bg-active')}
    >
      <span aria-hidden className={cx('whitespace-nowrap pr-1.5 text-caption text-muted mobile:hidden', selected && 'hidden')}>
        {actions[0] === 'join' ? t('search.hintVoice') : t('search.hintOpen')}
      </span>
      <span className={cx('items-center gap-1 mobile:flex', selected ? 'flex' : 'hidden')}>
        {actions.map((a, n) =>
          a === 'join' ? (
            <Button
              key={a}
              size="sm"
              aria-label={t('search.actionOn', { action: t('search.join'), name })}
              onClick={() => onPick(index, a)}
              className="mobile:size-11 mobile:rounded-full mobile:px-0"
            >
              <Phone className="size-3.5 mobile:size-5" aria-hidden />
              <span className="mobile:hidden">{t('search.join')}</span>
            </Button>
          ) : a === 'chat' && n > 0 ? (
            <IconButton
              key={a}
              size="sm"
              label={t('search.actionOn', { action: t('search.chat'), name })}
              onClick={() => onPick(index, a)}
              className="size-6 rounded-full mobile:size-11"
            >
              <MessageSquare className="size-3.5 mobile:size-5" aria-hidden />
            </IconButton>
          ) : (
            <Button
              key={a}
              size="sm"
              variant="secondary"
              aria-label={t('search.actionOn', { action: a === 'chat' ? t('search.chat') : t('search.open'), name })}
              onClick={() => onPick(index, a)}
              className="mobile:h-11 mobile:px-4"
            >
              {a === 'chat' ? t('search.chat') : t('search.open')}
            </Button>
          ),
        )}
      </span>
    </div>
  );
});

/** CONNECT in a voice room, reactive (a boolean selector: a role change re-renders only this row). */
function useCanConnect(room: Room | null): boolean {
  const me = useSession((s) => s.me?.user?.id ?? '');
  return useWorkspaces((s) => (room ? can(roomPerms(rolesOf(s.byId[room.workspaceId], me), me, room), 'CONNECT') : false));
}

/** The row's subject for the buttons' names («Подключиться: Созвон»). */
function rowName(it: Item): string {
  if (it.kind === 'dm') return it.name;
  if (it.kind === 'room') return it.room.name;
  if (it.kind === 'member') return it.member.nickname || it.member.user?.displayName || '';
  return memberName(useRooms.getState().byId[it.msg.roomId]?.workspaceId ?? null, it.msg.authorId);
}

function RowBody({ it, q, workspaceName, rooms }: { it: Item; q: string; workspaceName: string; rooms: Record<string, Room> }): ReactNode {
  const sub = 'shrink-0 truncate text-caption text-muted mobile:hidden';
  if (it.kind === 'dm') {
    const u = useWorkspaces.getState().users[it.peerId];
    return (
      <>
        <Avatar userId={it.peerId} name={it.name} fileId={u?.avatarFileId || undefined} size={20} />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={it.name} q={q} />
        </span>
        <span className={sub}>{t('search.dms')}</span>
      </>
    );
  }
  if (it.kind === 'room') {
    const r = it.room;
    const Icon = r.type === RoomType.VOICE ? Volume2 : Hash;
    return (
      <>
        <Icon className="size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <Highlight text={r.name} q={q} />
        </span>
        <span className={sub}>{workspaceName}</span>
      </>
    );
  }
  if (it.kind === 'member') {
    const u = it.member.user;
    const name = it.member.nickname || u?.displayName || '';
    const look = customLook(rolesOf(useWorkspaces.getState().byId[it.member.workspaceId], u?.id ?? ''));
    return (
      <>
        <Avatar userId={u?.id ?? ''} name={name} fileId={u?.avatarFileId || undefined} size={20} />
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className={cx('min-w-0 truncate', roleTextClass(it.member.role, 'role', look))} style={roleTextStyle(it.member.role, 'role', look)}>
            <Highlight text={name} q={q} />
          </span>
          <RoleMark role={it.member.role} custom={look} tone="role" />
        </span>
        <span className={sub}>{t('search.memberHint')}</span>
      </>
    );
  }
  const m = it.msg;
  const room = rooms[m.roomId];
  const d = toDate(m.createdAt);
  const wsId = room?.workspaceId ?? null;
  const text = systemPreview(m) || previewText(wsId, m.content) || t('chat.attachment');
  const author = memberName(wsId, m.authorId);
  const user = useWorkspaces.getState().users[m.authorId];
  return (
    <>
      <Avatar userId={m.authorId} name={author} fileId={user?.avatarFileId || undefined} size={28} className="self-start" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span className="truncate font-semibold">{author}</span>
          <span className="shrink-0 truncate text-caption text-muted">
            {room ? `${roomLabel(room)} · ` : ''}
            {fmt.dayLabel(d)}, {fmt.time(d)}
          </span>
        </span>
        <span className="line-clamp-2 break-words">
          <Highlight text={snippetAround(text, q)} q={q} />
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

/** Hits: 600 weight + accent text (the selected row is a neutral fill: the accent stays readable). */
function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  const parts = splitHits(text, searchWords(q));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-transparent font-semibold text-accent-text">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
