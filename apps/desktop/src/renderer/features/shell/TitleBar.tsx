import * as Popover from '@radix-ui/react-popover';
import { AtSign, ChevronLeft, ChevronRight, CircleHelp, Hash, Inbox, Search, Volume2 } from 'lucide-react';
import type { Message } from '@calaba/protocol';
import { useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Empty, IconButton, MOD, Spinner, Tip, cx } from '../../components/ui';
import { MediaImg } from '../../components/MediaImg';
import { t } from '../../i18n';
import { api, thumbnailPath } from '../../lib/api/endpoints';
import { fmtTime, toDate } from '../../lib/format';
import { loadMentions } from '../../services/mentions';
import { NAV_SHORTCUTS, SHORTCUTS, shortcutHelp } from '../../services/hotkeys';
import { platform } from '../../platform';
import { usePrefs } from '../../stores/prefs';
import { useInbox } from '../../stores/inbox';
import { idAfter, isVoice, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { canGoBack, canGoForward, useUi } from '../../stores/ui';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { useChatView } from '../chat/chatView';
import { fmtDayLabel } from '../chat/MessageBubble';
import { previewText } from '../chat/mentionText';
import { bindingLabel } from '../settings/PttBinder';
import { popoverBox } from './menu';
import { wsInitials } from './WorkspaceRail';

/**
 * Window title bar (docs/09 #1): 38 px across the whole window, drag region in Electron.
 * Left: 80 px kept empty for the macOS traffic lights (hiddenInset at 12,12), then ← → room
 * history. Centre: the workspace name. Right: search (opens the quick switcher), mentions,
 * shortcuts help; on Windows the native caption buttons (Window Controls Overlay) take the
 * space given by env(titlebar-area-*).
 */
export function TitleBar(): ReactNode {
  const os = useSession((s) => s.appInfo?.platform);
  const electron = platform.kind === 'electron';
  const mac = electron && os === 'darwin';
  const wsId = useUi((s) => s.activeWorkspaceId);
  const ws = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws : undefined));
  const back = useUi(canGoBack);
  const fwd = useUi(canGoForward);
  const goBack = useUi((s) => s.goBack);
  const goForward = useUi((s) => s.goForward);
  const open = useUi((s) => s.openDialog);

  return (
    <header
      aria-label={t('shell.titlebar')}
      className={cx(
        'mat-rail relative z-[var(--z-sticky)] grid h-[var(--titlebar-height)] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3',
        electron && 'drag',
      )}
      // Windows (WCO): keep clear of the native caption buttons; 0 elsewhere.
      style={{ paddingRight: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))' }}
    >
      <div className="flex min-w-0 items-center gap-0.5">
        {/* macOS traffic lights live here — nothing is drawn under them. */}
        <div className={cx('shrink-0', mac ? 'w-[80px]' : 'w-2')} aria-hidden />
        <IconButton size="sm" label={t('shell.back')} shortcut={NAV_SHORTCUTS.back} disabled={!back} onClick={goBack} className="size-7">
          <ChevronLeft className="size-[18px]" />
        </IconButton>
        <IconButton size="sm" label={t('shell.forward')} shortcut={NAV_SHORTCUTS.forward} disabled={!fwd} onClick={goForward} className="size-7">
          <ChevronRight className="size-[18px]" />
        </IconButton>
      </div>

      <div className="flex min-w-0 max-w-[40vw] items-center justify-center gap-2 text-[13px] font-semibold text-fg" title={ws?.name ?? 'Calaba'}>
        {ws ? (
          <span className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-[4px] bg-hover text-[8px] font-bold text-muted" aria-hidden>
            {ws.iconFileId ? <MediaImg path={thumbnailPath(ws.iconFileId)} alt="" className="size-full object-cover" /> : wsInitials(ws.name)}
          </span>
        ) : null}
        <span className="truncate">{ws?.name ?? 'Calaba'}</span>
      </div>

      <div className="flex min-w-0 items-center justify-end gap-1 pr-2">
        <button
          type="button"
          onClick={() => open({ kind: 'quick-switcher' })}
          aria-label={t('shell.search')}
          aria-keyshortcuts={MOD === '⌘' ? 'Meta+K' : 'Control+K'}
          className="flex h-6 w-[clamp(120px,14vw,200px)] min-w-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-hover px-2 text-[12px] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg"
        >
          <Search className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{t('shell.search')}</span>
          <kbd className="shrink-0 font-sans text-[11px] text-muted">
            {MOD}
            {SHORTCUTS.quickSwitch}
          </kbd>
        </button>
        <InboxButton />
        <HelpButton />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------- mentions inbox

/**
 * Mentions inbox (docs/09 #1): history from GET /api/me/mentions (all workspaces, newest
 * first) merged with live mentions. The badge counts unread mentions; a click opens the room
 * and jumps to the message.
 */
function InboxButton(): ReactNode {
  const mentions = useRooms((s) => s.mentions);
  const total = Object.values(mentions).reduce((a, b) => a + b, 0);
  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) void loadMentions();
      }}
    >
      <Tip label={t('shell.inbox')}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={total ? `${t('shell.inbox')}: ${total}` : t('shell.inbox')}
            className="relative grid size-7 place-items-center rounded-[var(--radius-control)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <Inbox className="size-[18px]" aria-hidden />
            {total > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger-fill px-1 text-center text-[10px] font-semibold leading-4 text-white" aria-hidden>
                {total > 99 ? '99+' : total}
              </span>
            ) : null}
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={8} aria-label={t('shell.inbox')} className={cx(popoverBox, 'w-[380px] p-0')}>
          <InboxList />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function InboxList(): ReactNode {
  const mentions = useRooms((s) => s.mentions);
  const roomsById = useRooms((s) => s.byId);
  const workspaces = useWorkspaces((s) => s.byId);
  const all = useInbox((s) => s.items);
  const loaded = useInbox((s) => s.loaded);
  const loading = useInbox((s) => s.loading);
  const hasMore = useInbox((s) => s.hasMore);
  // Only rooms (and workspaces) this client still knows: access may have changed.
  const items = useMemo(() => all.filter((m) => !!roomsById[m.roomId] && !!workspaces[roomsById[m.roomId]?.workspaceId ?? '']), [all, roomsById, workspaces]);
  const unreadRooms = Object.entries(mentions).filter(([id, n]) => n > 0 && roomsById[id]);
  const markAll = (): void => {
    const rooms = useRooms.getState();
    for (const [roomId] of unreadRooms) {
      const last = rooms.lastMessage[roomId];
      if (!last) continue;
      rooms.setRead(roomId, last);
      void api.messages.markRead(roomId, last).catch(() => undefined);
    }
  };
  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <AtSign className="size-4 text-muted" aria-hidden />
          {t('shell.inbox')}
        </span>
        {unreadRooms.length ? (
          <button type="button" onClick={markAll} className="rounded-[var(--radius-control)] px-1.5 py-0.5 text-[12px] text-accent-text hover:bg-hover">
            {t('shell.inboxMarkRead')}
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        !loaded && loading ? (
          <div className="grid place-items-center py-8">
            <Spinner />
          </div>
        ) : (
          <Empty>
            <div className="font-semibold text-fg">{t('shell.inboxEmpty')}</div>
            <div className="mt-1 text-[12px]">{t('shell.inboxHint')}</div>
          </Empty>
        )
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1">
          {items.map((m) => (
            <InboxItem key={m.id} m={m} />
          ))}
          {hasMore ? (
            <li className="flex justify-center py-1">
              <button
                type="button"
                disabled={loading}
                onClick={() => void loadMentions(true)}
                className="rounded-[var(--radius-control)] px-2 py-1 text-[12px] text-accent-text hover:bg-hover disabled:opacity-40"
              >
                {t('chat.inboxLoadMore')}
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function InboxItem({ m }: { m: Message }): ReactNode {
  const room = useRooms((s) => s.byId[m.roomId]);
  const unread = useRooms((s) => idAfter(m.id, s.readState[m.roomId]));
  const wsId = room?.workspaceId ?? null;
  const wsName = useWorkspaces((s) => (wsId ? s.byId[wsId]?.ws.name : undefined));
  const author = useMemberName(wsId, m.authorId);
  const avatar = useWorkspaces((s) => s.users[m.authorId]?.avatarFileId);
  // Re-render on nickname changes of mentioned people too.
  const text = useWorkspaces(() => previewText(wsId, m.content)) || t('chat.attachment');
  const openRoom = useUi((s) => s.openRoom);
  if (!room) return null;
  const Icon = isVoice(room) ? Volume2 : Hash;
  const d = toDate(m.createdAt);
  return (
    <li>
      <Popover.Close asChild>
        <button
          type="button"
          onClick={() => {
            openRoom(room.workspaceId, room.id);
            useChatView.getState().requestJump(room.id, m.id);
          }}
          className="flex w-full items-start gap-2.5 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-hover"
        >
          <Avatar userId={m.authorId} name={author} fileId={avatar || undefined} size={28} />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 truncate text-[13px] font-semibold" title={author}>
                {author}
              </span>
              <span className="ml-auto shrink-0 text-[11px] text-muted">
                {fmtDayLabel(d)}, {fmtTime(d)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-muted">
              <Icon className="size-3 shrink-0" aria-hidden />
              <span className="truncate" title={`${room.name} · ${wsName ?? ''}`}>
                {room.name} · {wsName}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-2 break-words text-[13px] text-fg">{text}</span>
          </span>
          {unread ? <span className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" role="img" aria-label={t('chat.inboxUnread')} /> : null}
        </button>
      </Popover.Close>
    </li>
  );
}

// ---------------------------------------------------------------- shortcuts help

function HelpButton(): ReactNode {
  const binding = usePrefs((s) => s.pttBinding);
  const os = useSession((s) => s.appInfo?.platform ?? '');
  const open = useUi((s) => s.openDialog);
  const rows = [...shortcutHelp().map((r) => ({ keys: r.keys, label: t(r.label) })), { keys: binding ? bindingLabel(binding, os) : t('shell.kbd.pttNone'), label: t('shell.kbd.ptt') }];
  return (
    <Popover.Root>
      <Tip label={t('shell.help')}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={t('shell.help')}
            className="grid size-7 place-items-center rounded-[var(--radius-control)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg data-[state=open]:bg-active data-[state=open]:text-fg"
          >
            <CircleHelp className="size-[18px]" aria-hidden />
          </button>
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} collisionPadding={8} aria-label={t('shell.help')} className={cx(popoverBox, 'w-[300px] p-3')}>
          <div className="mb-2 text-[13px] font-semibold">{t('shell.help')}</div>
          <dl className="flex flex-col gap-1.5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <dt className="min-w-0 truncate text-[13px] text-muted">{r.label}</dt>
                <dd className="shrink-0">
                  <kbd className="rounded-[4px] border border-line bg-hover px-1.5 py-px font-sans text-[12px] text-fg">{r.keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
          <Popover.Close asChild>
            <button type="button" onClick={() => open({ kind: 'settings', tab: 'voice' })} className="mt-3 text-[12px] text-accent-text hover:underline">
              {t('shell.kbd.settings')}
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
