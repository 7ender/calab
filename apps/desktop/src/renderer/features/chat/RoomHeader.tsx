import { NotificationLevel, RoomType, type PermissionBits, type Room } from '@calaba/protocol';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Bell, BellDot, BellOff, Check, Hash, Pin, PinOff, Search, Settings, Users, Volume2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { IconButton, MOD, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { fmtTime, toDate } from '../../lib/format';
import { can } from '../../lib/permissions';
import { setPinned } from '../../services/chat';
import { setRoomNotifications } from '../../services/mentions';
import { isQuiet, roomNotify, useRooms } from '../../stores/rooms';
import { useMessages } from '../../stores/messages';
import { useUi } from '../../stores/ui';
import { memberName } from '../../stores/workspaces';
import { useChatView } from './chatView';
import { roomLabel } from './roomLabel';
import { fmtDayLabel } from './MessageBubble';
import { menuBox, menuItem, menuLabel, menuSeparator } from '../shell/menu';
import { previewText } from './mentionText';
import { TypingDots, useTypingText } from './TypingIndicator';

const NO_PINS: never[] = [];

/**
 * Room header (docs/09 #7): icon, name, • topic (or «… печатает» while someone types), and on
 * the right: search, pinned, notifications, settings, members.
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

  return (
    <header className="mat-toolbar drag sticky top-0 z-[var(--z-sticky)] flex h-12 shrink-0 items-center gap-2 border-b border-line pl-4 pr-2">
      <Icon className="size-5 shrink-0 text-faint" aria-hidden />
      <h1 className="min-w-0 max-w-[40%] shrink-0 truncate text-list font-semibold" title={room.name}>
        {room.name}
      </h1>
      {typing ? (
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
        <IconButton label={t('chat.searchInRoom', { room: roomLabel(room) })} shortcut={`${MOD}F`} active={searchOpen} onClick={() => setSearch(searchOpen ? null : room.id)}>
          <Search className="size-[18px]" />
        </IconButton>
        <PinsButton workspaceId={workspaceId} roomId={room.id} canManage={can(perms, 'MANAGE_MESSAGES')} />
        <NotifyButton roomId={room.id} />
        {can(perms, 'MANAGE_ROOM') ? (
          <IconButton label={t('room.settings')} onClick={() => openDialog({ kind: 'room-settings', roomId: room.id })}>
            <Settings className="size-[18px]" />
          </IconButton>
        ) : null}
        <IconButton label={t('shell.members')} active={membersOpen} onClick={toggleMembers}>
          <Users className="size-[18px]" />
        </IconButton>
      </div>
    </header>
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
function NotifyButton({ roomId }: { roomId: string }): ReactNode {
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
          <IconButton tip={false} label={t('chat.notifyState', { state: state.toLowerCase() })} active={open} className={cx(quiet && !open && 'text-faint')}>
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
                  <li key={m.id} className="group flex items-start gap-1 rounded-[var(--radius-control)] hover:bg-hover">
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
