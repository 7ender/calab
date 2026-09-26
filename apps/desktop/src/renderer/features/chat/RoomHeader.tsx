import { NotificationLevel, PresenceStatus, RoomType, type PermissionBits, type Room } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bell, BellDot, BellOff, Check, Hash, Pin, PinOff, Search, Settings, Users, Volume2 } from 'lucide-react';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconButton, MOD, Tip, cx } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { fmtTime, toDate } from '../../lib/format';
import { can, mayPin } from '../../lib/permissions';
import { setPinned } from '../../services/chat';
import { useHotkeyLabel } from '../../services/hotkeys';
import { setRoomNotifications } from '../../services/mentions';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useMobile } from '../../lib/mobile';
import { NavButton } from '../shell/MobileShell';
import { isQuiet, roomNotify, useRooms } from '../../stores/rooms';
import { useMessages } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { useDms } from '../../stores/dms';
import { memberName, useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { roomLabel } from './roomLabel';
import { fmtDayLabel } from './MessageBubble';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
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
  return (
    <header className="mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2" data-testid="dm-header">
      <Avatar userId={peerId} name={name} fileId={user?.avatarFileId || undefined} size={28} presence className="[&>span:last-child]:border-[var(--color-bg)]" />
      <h1 className="min-w-0 max-w-[40%] shrink-0 truncate text-list font-semibold" title={name}>
        {name}
      </h1>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-body" aria-live="polite">
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
      <div className="no-drag flex shrink-0 items-center gap-0.5">
        <IconButton label={t('dm.searchIn')} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)}>
          <Search className="size-[18px]" />
        </IconButton>
        <PinsButton workspaceId="" roomId={room.id} canManage />
        <NotifyButton roomId={room.id} />
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

const LEVELS = [
  { level: NotificationLevel.ALL, label: 'chat.notifyAll' },
  { level: NotificationLevel.MENTIONS, label: 'chat.notifyMentions' },
  { level: NotificationLevel.NONE, label: 'chat.notifyNone' },
] as const;

const MUTES = [
  { ms: 15 * 60_000, label: 'chat.notifyMute15m' },
  { ms: 60 * 60_000, label: 'chat.notifyMute1h' },
  { ms: 8 * 60 * 60_000, label: 'chat.notifyMute8h' },
  { ms: 24 * 60 * 60_000, label: 'chat.notifyMute24h' },
] as const;

/** «Выключены до 14:30». Open-ended «Пока не включу» is level NONE without muted_until (docs/05). */
function mutedText(until: number): string {
  return t('chat.notifyMutedUntil', { time: fmtUntil(until) });
}

const untilFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** «14:30» today, «16 янв., 14:30» on another day. */
function fmtUntil(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? fmtTime(d) : untilFmt.format(d);
}

/**
 * Room notifications (docs/05, «Уведомления комнаты»): level (all / mentions / nothing) and a
 * temporary «do not disturb». Server-synced across devices; the bell shows the state.
 */
function NotifyButton({ roomId, className }: { roomId: string; className?: string | undefined }): ReactNode {
  const stored = useRooms((s) => s.notify[roomId]);
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const n = roomNotify(stored, now);
  // Re-evaluate when a temporary mute runs out (the icon flips back by itself).
  useEffect(() => {
    if (!n.mutedUntil) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.min(n.mutedUntil - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(id);
  }, [n.mutedUntil]);
  const quiet = isQuiet(n);
  const Icon = quiet ? BellOff : n.level === NotificationLevel.MENTIONS ? BellDot : Bell;
  const levelText = t(LEVELS.find((l) => l.level === n.level)?.label ?? 'chat.notifyAll');
  const state = n.mutedUntil ? mutedText(n.mutedUntil) : levelText;
  return (
    <Dropdown.Root modal={false} open={open} onOpenChange={(v) => {
        setOpen(v);
        if (v) setNow(Date.now());
      }}>
      <Tip label={t('chat.notifyState', { state: state.toLowerCase() })}>
        <Dropdown.Trigger asChild>
          <IconButton tip={false} label={t('chat.notifyState', { state: state.toLowerCase() })} active={open} className={cx(quiet && !open && 'text-faint', className)}>
            <Icon className="size-[18px]" />
          </IconButton>
        </Dropdown.Trigger>
      </Tip>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} collisionPadding={16} className={menuBox} aria-label={t('chat.notify')}>
          <Dropdown.Label className={menuLabel}>{t('chat.notify')}</Dropdown.Label>
          <Dropdown.RadioGroup
            value={String(n.level)}
            onValueChange={(v) => void setRoomNotifications(roomId, Number(v), n.mutedUntil)}
          >
            {LEVELS.map((l) => (
              <Dropdown.RadioItem key={l.level} value={String(l.level)} className={menuItem}>
                <span className="grid w-4 place-items-center">
                  <Dropdown.ItemIndicator>
                    <Check className="size-4" aria-hidden />
                  </Dropdown.ItemIndicator>
                </span>
                {t(l.label)}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
          <Dropdown.Separator className={menuSeparator} />
          <Dropdown.Label className={menuLabel}>
            {n.mutedUntil ? mutedText(n.mutedUntil) : t('chat.notifyMute')}
          </Dropdown.Label>
          {MUTES.map((m) => (
            <Dropdown.Item key={m.ms} className={menuItem} onSelect={() => void setRoomNotifications(roomId, n.level, Date.now() + m.ms)}>
              <span className="w-4" aria-hidden />
              {t(m.label)}
            </Dropdown.Item>
          ))}
          {/* Open-ended: level NONE without muted_until (the server's permanent mute). */}
          <Dropdown.Item className={menuItem} onSelect={() => void setRoomNotifications(roomId, NotificationLevel.NONE, null)}>
            <span className="w-4" aria-hidden />
            {t('chat.notifyMuteForever')}
          </Dropdown.Item>
          {n.mutedUntil || n.level === NotificationLevel.NONE ? (
            <>
              <Dropdown.Separator className={menuSeparator} />
              <Dropdown.Item
                className={menuItem}
                onSelect={() =>
                  void setRoomNotifications(roomId, n.level === NotificationLevel.NONE ? NotificationLevel.ALL : n.level, null)
                }
              >
                <Bell className="size-4" aria-hidden /> {t('chat.notifyUnmute')}
              </Dropdown.Item>
            </>
          ) : null}
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
                          {fmtDayLabel(d)}, {fmtTime(d)}
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
