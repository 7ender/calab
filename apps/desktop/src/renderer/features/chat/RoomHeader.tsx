import { NotificationLevel, PresenceStatus, RoomType, type PermissionBits, type Room } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bell, BellOff, BellRing, Hash, Phone, Pin, PinOff, Search, Settings, Users, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, IconButton, MOD, Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { fmt, toDate } from '../../lib/format';
import { can, mayPin } from '../../lib/permissions';
import { setPinned } from '../../services/chat';
import { useHotkeyLabel } from '../../services/hotkeys';
import { setRoomNotifications } from '../../services/mentions';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useMobile } from '../../lib/mobile';
import { NavButton } from '../shell/MobileShell';
import { effectiveNotify, useRooms } from '../../stores/rooms';
import { useMessages } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useVoiceStates } from '../../stores/voicePending';
import { toast } from '../../stores/toasts';
import { voice } from '../../services/voice';
import { isVoicePreview, joinOutcome } from '../../lib/voiceEntry';
import { useDms } from '../../stores/dms';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { roomLabel } from './roomLabel';
import { menuBox } from '../shell/menu';
import { LEVEL_LABEL, NotifyMenuItems, mutedText, type LevelOption } from './NotifyMenu';
import { previewText } from './mentionText';
import { TypingDots, useTypingText } from './TypingIndicator';

const NO_PINS: never[] = [];

/** From this window width the header has a search field; narrower windows keep the ⌘K entry in the title bar. */
export const HEADER_SEARCH_MIN = 1200;

/**
 * Room header (docs/09 #7): icon, name, • topic (or «… печатает» while someone types), and on
 * the right: workspace search field (≥ 1200 px, docs/09 #50), search in room, pinned,
 * notifications, settings, members.
 */
export function RoomHeader({
  workspaceId,
  room,
  perms,
  membersOpen,
  toggleMembers,
}: {
  workspaceId: string;
  room: Room;
  perms: PermissionBits;
  membersOpen: boolean;
  toggleMembers: () => void;
}): ReactNode {
  const openDialog = useUi((s) => s.openDialog);
  const typing = useTypingText(workspaceId, room.id);
  const searchOpen = useChatView((s) => s.searchRoom === room.id);
  const setSearch = useChatView((s) => s.setSearch);
  const voiceRoom = room.type === RoomType.VOICE;
  const Icon = voiceRoom ? Volume2 : Hash;
  const wide = useMediaQuery(`(min-width: ${HEADER_SEARCH_MIN}px)`);
  // Phone layout (ADR-0021): this header is the top bar — ☰ (rooms drawer) first, the name takes
  // the room; search, notifications and members stay (pins show in the pinned bar, room settings in
  // the drawer's room menu), 40 px touch targets.
  const mobile = useMobile();
  const touch = mobile ? 'size-10 rounded-full' : undefined;

  return (
    <header className={cx('mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2', mobile && 'gap-1 pl-1 pr-1')}>
      {mobile ? <NavButton /> : null}
      <Icon className="size-5 shrink-0 text-faint" aria-hidden />
      <h1 className={cx('min-w-0 max-w-[40%] shrink-0 truncate text-list font-semibold', mobile && 'max-w-none flex-1 shrink')} title={room.name}>
        {room.name}
      </h1>
      {voiceRoom ? <VoicePreviewBar workspaceId={workspaceId} room={room} perms={perms} /> : null}
      {mobile ? null : typing ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-body text-accent-text" aria-live="polite">
          <span className="text-faint" aria-hidden>
            •
          </span>
          <span className="truncate">{typing}</span>
          <TypingDots />
        </span>
      ) : room.topic ? (
        <Topic topic={room.topic} />
      ) : (
        <div className="flex-1" />
      )}
      <div className="no-drag flex shrink-0 items-center gap-0.5">
        {wide ? <HeaderSearch workspaceId={workspaceId} /> : null}
        <IconButton label={t('chat.searchInRoom', { room: roomLabel(room) })} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)} className={touch}>
          <Search className="size-[18px]" />
        </IconButton>
        {mobile ? null : <PinsButton workspaceId={workspaceId} roomId={room.id} canManage={mayPin(perms, room)} />}
        <NotifyButton roomId={room.id} className={touch} />
        {can(perms, 'MANAGE_ROOM') && !mobile ? (
          <IconButton label={t('room.settings')} onClick={() => openDialog({ kind: 'room-settings', roomId: room.id })}>
            <Settings className="size-[18px]" />
          </IconButton>
        ) : null}
        <IconButton label={t('shell.members')} active={membersOpen} onClick={toggleMembers} className={touch}>
          <Users className="size-[18px]" />
        </IconButton>
      </div>
    </header>
  );
}

/**
 * A voice room's chat read without being in its voice (docs/09 #14): «Вы не в голосе» and
 * «Войти в голос» next to the name (same join rules as a click on the room). A call in another
 * room is not touched until the button is pressed. Phone: the button only, icon-sized.
 */
function VoicePreviewBar({ workspaceId, room, perms }: { workspaceId: string; room: Room; perms: PermissionBits }): ReactNode {
  const preview = useVoice((s) => isVoicePreview(room, s.roomId));
  const states = useVoiceStates(workspaceId);
  const mobile = useMobile();
  if (!preview) return null;
  const people = Object.values(states).filter((v) => v.roomId === room.id).length;
  const canConnect = can(perms, 'CONNECT');
  const join = (): void => {
    const next = joinOutcome({ inRoom: false, canConnect, canMove: can(perms, 'MOVE_MEMBERS'), people, limit: room.userLimit });
    if (next === 'full') toast.info(t('shell.roomFull'));
    else if (next === 'join') void voice.join(room.id, workspaceId);
  };
  return (
    <div className="no-drag flex shrink-0 items-center gap-2" data-testid="voice-preview">
      {mobile ? null : <Badge className="text-muted">{t('voicePreview.notInVoice')}</Badge>}
      {!canConnect ? null : mobile ? (
        <IconButton label={t('voicePreview.join')} onClick={join} className="size-10 rounded-full text-ok">
          <Phone className="size-5" />
        </IconButton>
      ) : (
        <Button size="sm" onClick={join}>
          <Phone className="size-3.5" aria-hidden />
          {t('voicePreview.join')}
        </Button>
      )}
    </div>
  );
}

const PRESENCE_KEY: Partial<Record<PresenceStatus, MessageKey>> = {
  [PresenceStatus.ONLINE]: 'presence.online',
  [PresenceStatus.IDLE]: 'presence.idle',
  [PresenceStatus.DND]: 'presence.dnd',
};

/**
 * DM header (ADR-0020): the peer's avatar with presence, name, • presence and custom status
 * (or «… печатает»); on the right search in the chat, pinned, notifications. No members,
 * settings or workspace search: a DM has none of them. Both participants pin (docs/04).
 */
export function DmHeader({ room }: { room: Room }): ReactNode {
  const peerId = useDms((s) => s.byRoom[room.id]?.peerId ?? '');
  const name = useMemberName(null, peerId);
  const user = useWorkspaces((s) => s.users[peerId]);
  const status = useWorkspaces((s) => s.presences[peerId]?.status);
  const typing = useTypingText('', room.id);
  const searchOpen = useChatView((s) => s.searchRoom === room.id);
  const setSearch = useChatView((s) => s.setSearch);
  const presenceKey = status !== undefined ? PRESENCE_KEY[status] : undefined;
  const custom = [user?.statusEmoji, user?.statusText].filter(Boolean).join(' ');
  const sub = [t(presenceKey ?? 'members.offline'), custom].filter(Boolean).join(' · ');
  // Phone layout (ADR-0021): the top bar — ☰ (DM list drawer) first, 40 px touch targets, pins
  // in the pinned bar.
  const mobile = useMobile();
  const touch = mobile ? 'size-10 rounded-full' : undefined;
  return (
    <header
      className={cx('mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2', mobile && 'gap-1.5 pl-1 pr-1')}
      data-testid="dm-header"
    >
      {mobile ? <NavButton /> : null}
      <Avatar userId={peerId} name={name} fileId={user?.avatarFileId || undefined} size={28} presence className="[&>span:last-child]:border-[var(--color-bg)]" />
      <h1 className={cx('min-w-0 max-w-[40%] shrink-0 truncate text-list font-semibold', mobile && 'max-w-none shrink')} title={name}>
        {name}
      </h1>
      <span className={cx('flex min-w-0 flex-1 items-center gap-1.5 text-body', mobile && 'hidden')} aria-live="polite">
        <span className="text-faint" aria-hidden>
          •
        </span>
        {typing ? (
          <>
            <span className="truncate text-accent-text">{typing}</span>
            <TypingDots />
          </>
        ) : (
          <span className="truncate text-muted" title={sub}>
            {sub}
          </span>
        )}
      </span>
      <div className={cx('no-drag flex shrink-0 items-center gap-0.5', mobile && 'ml-auto')}>
        <IconButton label={t('dm.searchIn')} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)} className={touch}>
          <Search className="size-[18px]" />
        </IconButton>
        {mobile ? null : <PinsButton workspaceId="" roomId={room.id} canManage />}
        <NotifyButton roomId={room.id} className={touch} />
      </div>
    </header>
  );
}

/**
 * «Поиск в <пространство>» (docs/09 #50): a bigger entry point to the one workspace search —
 * the ⌘K quick switcher (rooms, members, messages). Clicking or Enter opens it; typing opens it
 * with the typed text. The shortcut hint follows the rebindable hotkey.
 */
function HeaderSearch({ workspaceId }: { workspaceId: string }): ReactNode {
  const name = useWorkspaces((s) => s.byId[workspaceId]?.ws.name ?? '');
  const keys = useHotkeyLabel('search');
  const label = t('chat.searchWorkspace', { name });
  const open = (query = ''): void => useUi.getState().openDialog({ kind: 'quick-switcher', query });
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    }
  };
  return (
    <div className="relative mr-1 w-[240px] shrink-0" data-testid="header-search">
      <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        value=""
        onChange={(e) => open(e.target.value)}
        onKeyDown={onKey}
        onMouseDown={(e) => {
          e.preventDefault();
          open();
        }}
        placeholder={label}
        aria-label={label}
        aria-haspopup="dialog"
        className="h-7 w-full min-w-0 cursor-default text-ellipsis rounded-[var(--radius-control)] bg-hover pl-7 pr-11 text-body text-fg transition-colors duration-[var(--motion-fast)] placeholder:text-muted hover:bg-[var(--color-fill-hover)] focus-visible:outline-offset-0 [&::-webkit-search-cancel-button]:hidden"
      />
      <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-sans text-micro text-muted">{keys}</kbd>
    </div>
  );
}

/**
 * Room notifications (docs/05 «Уведомления», docs/09 item 22): «Как в пространстве» (the
 * default) / all / mentions / nothing, and «Заглушить» for a while or for good. Server-synced
 * across devices; the bell shows the effective state (crossed out while silent).
 */
function NotifyButton({ roomId, className }: { roomId: string; className?: string | undefined }): ReactNode {
  const stored = useRooms((s) => s.notify[roomId]);
  const room = useRooms((s) => s.byId[roomId]);
  const wsId = room?.workspaceId ?? '';
  const wsStored = useRooms((s) => (wsId ? s.wsNotify[wsId] : undefined));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // «Где настроить» in Settings → Звуки opens this menu (after the settings dialog closes).
  const req = useUi((s) => s.notifyMenuReq);
  const seenReq = useRef(req);
  useEffect(() => {
    if (req === seenReq.current) return;
    seenReq.current = req;
    const id = window.setTimeout(() => {
      setNow(Date.now());
      setOpen(true);
    }, 150);
    return () => window.clearTimeout(id);
  }, [req]);
  const eff = effectiveNotify(
    roomId,
    {
      byId: room ? { [roomId]: room } : {},
      notify: stored ? { [roomId]: stored } : {},
      wsNotify: wsStored ? { [wsId]: wsStored } : {},
    },
    now,
  );
  // Re-evaluate when a temporary mute (of the room or its workspace) runs out: the icon flips back.
  const nextEnd = Math.min(eff.room.mutedUntil ?? Infinity, eff.dm ? Infinity : (eff.workspace.mutedUntil ?? Infinity));
  useEffect(() => {
    if (nextEnd === Infinity) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(nextEnd - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [nextEnd]);
  const wsLevel = t(LEVEL_LABEL[eff.workspace.level] ?? 'chat.notifyMentions');
  // A DM notifies every message: «Все сообщения» (the default) or «Ничего».
  const options: LevelOption[] = eff.dm
    ? [
        { level: NotificationLevel.INHERIT, label: t('chat.notifyAll') },
        { level: NotificationLevel.NONE, label: t('chat.notifyNone') },
      ]
    : [
        { level: NotificationLevel.INHERIT, label: t('chat.notifyInherit', { level: wsLevel }) },
        { level: NotificationLevel.ALL, label: t('chat.notifyAll') },
        { level: NotificationLevel.MENTIONS, label: t('chat.notifyMentions') },
        { level: NotificationLevel.NONE, label: t('chat.notifyNone') },
      ];
  const value = eff.dm && eff.room.level !== NotificationLevel.NONE ? NotificationLevel.INHERIT : eff.room.level;
  const Icon = eff.quiet ? BellOff : !eff.dm && eff.level === NotificationLevel.ALL ? BellRing : Bell;
  const wsMuted = !eff.dm && eff.workspace.mutedUntil ? eff.workspace.mutedUntil : null;
  const state = eff.room.mutedUntil
    ? mutedText(eff.room.mutedUntil)
    : wsMuted
      ? t('chat.notifyWsMutedUntil', { time: fmt.until(new Date(wsMuted)) })
      : (options.find((o) => o.level === value)?.label ?? '');
  const tip = t('chat.notifyState', { state: state.toLowerCase() });
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v) setNow(Date.now());
      }}>
      <Tip label={tip}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={tip} active={open} className={cx(eff.quiet && !open && 'text-faint', className)}>
            <Icon className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} collisionPadding={16} className={cx(menuBox, 'max-w-80')} aria-label={t('chat.notify')}>
          <NotifyMenuItems
            title={t('chat.notify')}
            options={options}
            value={value}
            mutedUntil={eff.room.mutedUntil}
            defaultLevel={NotificationLevel.INHERIT}
            note={wsMuted && !eff.room.mutedUntil ? t('chat.notifyWsMutedUntil', { time: fmt.until(new Date(wsMuted)) }) : undefined}
            onChange={(level, until) => void setRoomNotifications(roomId, level, until)}
          />
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Topic: one line with ellipsis; click shows the whole text. */
function Topic({ topic }: { topic: string }): ReactNode {
  return (
    <Popover.Root modal={false}>
      <span className="text-faint" aria-hidden>
        •
      </span>
      <Popover.Trigger asChild>
        <button type="button" className="no-drag min-w-0 flex-1 truncate text-left text-body text-muted hover:text-fg" title={topic} aria-label={t('chat.topic')}>
          {topic}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="mat-popover anim-in selectable z-[var(--z-popover)] max-w-[min(480px,calc(100vw-32px))] whitespace-pre-wrap break-words rounded-[var(--radius-card)] px-3 py-2 text-body text-fg"
        >
          {topic}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function PinsButton({ workspaceId, roomId, canManage }: { workspaceId: string; roomId: string; canManage: boolean }): ReactNode {
  const pins = useMessages((s) => s.pins[roomId] ?? NO_PINS);
  const jump = useChatView((s) => s.requestJump);
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip label={t('chat.pinned')}>
        <Popover.Trigger asChild>
          <IconButton tip={false} label={pins.length ? `${t('chat.pinned')}: ${pins.length}` : t('chat.pinned')} active={open}>
            <Pin className="size-[18px]" />
          </IconButton>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          aria-label={t('chat.pinned')}
          className="mat-popover dense anim-in z-[var(--z-popover)] flex max-h-[min(480px,70vh)] w-[360px] flex-col overflow-hidden rounded-[var(--radius-panel)]"
        >
          <div className="border-b border-line px-4 py-2.5 text-body font-semibold">{t('chat.pinned')}</div>
          {pins.length === 0 ? (
            <p className="px-4 py-8 text-center text-body text-muted">{t('chat.noPins')}</p>
          ) : (
            <ul className="min-h-0 overflow-y-auto p-1">
              {pins.map((m) => {
                const d = toDate(m.createdAt);
                return (
                  <li key={m.id} className="group flex items-start gap-1 rounded-[var(--radius-row)] hover:bg-hover">
                    <button
                      type="button"
                      className="min-w-0 flex-1 px-3 py-2 text-left"
                      onClick={() => {
                        jump(roomId, m.id);
                        setOpen(false);
                      }}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-body font-semibold">{memberName(workspaceId, m.authorId)}</span>
                        <span className="shrink-0 text-caption text-faint">
                          {fmt.dayLabel(d)}, {fmt.time(d)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-body text-muted">
                        {previewText(workspaceId, m.content) || (m.attachments.length ? t('chat.attachment') : '')}
                      </span>
                    </button>
                    {canManage ? (
                      <IconButton
                        label={t('chat.unpin')}
                        size="sm"
                        className={cx('mr-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}
                        onClick={() => void setPinned(m, false)}
                      >
                        <PinOff className="size-4" />
                      </IconButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
