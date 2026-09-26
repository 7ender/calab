import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { create } from '@bufbuild/protobuf';
import { timestampMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomCategorySchema, WorkspaceRole, type Room, type RoomCategory, type VoiceState } from '@calaba/protocol';
import {
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserPlus,
  Users,
  MessageSquare,
  Video,
  Volume2,
} from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Badge, Button, Empty, Field, Input, Modal, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { can, isAdminRole, roomPerms, workspacePerms } from '../../lib/permissions';
import { voice } from '../../services/voice';
import { groupRooms, isUnread, isVoice, roomNotify, roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { setRoomNotifications } from '../../services/mentions';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { formatDuration, limitLabel, useNow } from './voiceFormat';
import { menuBox, menuItem, menuLabel, menuSeparator } from './menu';
import { MemberContextMenu } from '../people/MemberContextMenu';
import { NicknameDialog } from '../people/NicknameDialog';
import { ProfileCard } from '../people/ProfileCard';
import { moveMember } from '../people/actions';
import { errorText } from '../../lib/api/errors';
import { VoiceInviteRow, VoiceStatusLine, useStatusLine } from './VoiceRoomRows';
import { VoiceStateIcons } from '../voice/VoiceStateIcons';
import { useTimeZoneLabel } from '../../services/timezone';

export { menuBox, menuItem };

const errText = (e: unknown): string => errorText(e);

/** Drag payloads (docs/09 #32): a voice participant onto a voice room. */
interface DragMember {
  userId: string;
  fromRoomId: string;
  name: string;
}
interface DropRoom {
  roomId: string;
  canMove: boolean;
}

/**
 * Room column (docs/09 #4): workspace header with ▾ menu and «invite», rooms grouped by
 * collapsible categories, voice rooms with their participants (drag between voice rooms with
 * MOVE_MEMBERS), then the voice panel and the self panel.
 */
export function Sidebar({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const roomsById = useRooms((s) => s.byId);
  const categoriesById = useRooms((s) => s.categories);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const open = useUi((s) => s.openDialog);
  const [catDialog, setCatDialog] = useState<{ category?: RoomCategory } | null>(null);
  const role = entry?.role;
  const admin = isAdminRole(role);
  const manageRooms = can(workspacePerms(role), 'MANAGE_ROOM');
  const groups = useMemo(() => {
    const rooms = roomsOfWorkspace(roomsById, workspaceId);
    const cats = Object.values(categoriesById).filter((c) => c.workspaceId === workspaceId);
    if (cats.length) return groupRooms(rooms, cats, manageRooms).map((g) => ({ ...g, kind: undefined }));
    // No categories yet: the classic two sections (not stored on the server), each with «+».
    return (['text', 'voice'] as const)
      .map((kind) => ({
        kind,
        category: create(RoomCategorySchema, {
          id: `__${kind}:${workspaceId}`,
          workspaceId,
          name: kind === 'text' ? t('room.textRooms') : t('room.voiceRooms'),
        }),
        rooms: rooms.filter((r) => isVoice(r) === (kind === 'voice')),
      }))
      .filter((g) => g.rooms.length || manageRooms);
  }, [roomsById, categoriesById, workspaceId, manageRooms]);
  if (!entry) return null;
  const empty = groups.length === 0;

  return (
    <aside className="mat-sidebar flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('room.list')}>
      <WorkspaceHeader workspaceId={workspaceId} onCreateCategory={() => setCatDialog({})} />
      <VoiceDnd workspaceId={workspaceId}>
        {/* The bottom island (AppShell) floats over the column's foot: the list ends above it. */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pt-2" style={{ paddingBottom: 'calc(var(--island-height, 0px) + 20px)' }}>
          {empty ? (
            <Empty
              action={
                manageRooms ? (
                  <Button size="sm" onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                    <Plus className="size-3.5" /> {t('room.create')}
                  </Button>
                ) : undefined
              }
            >
              {manageRooms ? t('shell.noRooms') : t('shell.noRoomsMember')}
            </Empty>
          ) : null}
          {groups.map((g) => (
            <CategoryGroup
              key={g.category?.id ?? 'none'}
              category={g.category}
              kind={g.kind}
              workspaceId={workspaceId}
              canManage={manageRooms}
              onEdit={(category) => setCatDialog({ category })}
            >
              {g.rooms.map((r) =>
                isVoice(r) ? (
                  <VoiceRoomRow key={r.id} room={r} workspaceId={workspaceId} me={me} role={entry.role} admin={admin} voiceStates={entry.voice} />
                ) : (
                  <TextRoomRow key={r.id} room={r} workspaceId={workspaceId} me={me} role={entry.role} admin={admin} />
                ),
              )}
            </CategoryGroup>
          ))}
        </div>
      </VoiceDnd>
      {catDialog ? <CategoryDialog workspaceId={workspaceId} category={catDialog.category} onClose={() => setCatDialog(null)} /> : null}
    </aside>
  );
}

// ---------------------------------------------------------------- header

function WorkspaceHeader({ workspaceId, onCreateCategory }: { workspaceId: string; onCreateCategory: () => void }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const open = useUi((s) => s.openDialog);
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const manageRooms = can(workspacePerms(entry.role), 'MANAGE_ROOM');

  const leave = async (): Promise<void> => {
    if (!(await confirmAction(t('ws.leave'), t('ws.leaveConfirm', { name: entry.ws.name }), t('ws.leave')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, '@me');
    } catch (e) {
      toast.error(errText(e));
    }
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pl-2 pr-2">
      <Dropdown.Root modal={false}>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            className="group flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] px-2 text-left text-list font-semibold text-fg transition-colors duration-[var(--motion-fast)] hover:bg-hover data-[state=open]:bg-active"
            title={entry.ws.name}
          >
            <span className="min-w-0 flex-1 truncate">{entry.ws.name}</span>
            <ChevronDown
              className="size-4 shrink-0 text-muted transition-transform duration-[var(--motion-fast)] group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={cx(menuBox, 'w-60')} sideOffset={4} align="start">
            {admin ? (
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
                <UserPlus className="size-4" /> {t('ws.invite')}
              </Dropdown.Item>
            ) : null}
            {admin ? (
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId })}>
                <Settings className="size-4" /> {t('ws.settings')}
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'members' })}>
              <Users className="size-4" /> {t('ws.members')}
            </Dropdown.Item>
            <WorkspaceNotifyMenu workspaceId={workspaceId} />
            {manageRooms ? (
              <>
                <Dropdown.Separator className={menuSeparator} />
                <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                  <Plus className="size-4" /> {t('room.create')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={onCreateCategory}>
                  <FolderPlus className="size-4" /> {t('shell.categoryCreate')}
                </Dropdown.Item>
              </>
            ) : null}
            <Dropdown.Separator className={menuSeparator} />
            {/* The owner cannot leave (ownership is not transferable yet): shown, disabled, with the reason. */}
            <Dropdown.Item
              className={cx(menuItem, 'text-danger-text')}
              disabled={entry.role === WorkspaceRole.OWNER}
              title={entry.role === WorkspaceRole.OWNER ? t('shell.ownerCannotLeave') : undefined}
              onSelect={() => void leave()}
            >
              <LogOut className="size-4" /> {t('ws.leave')}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>
      {admin ? (
        <Tip label={t('shell.invite')}>
          <button
            type="button"
            aria-label={t('ws.invite')}
            onClick={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}
            className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-hover hover:text-fg"
          >
            <UserPlus className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

const WS_LEVELS = [
  { level: NotificationLevel.ALL, label: 'chat.notifyAll' },
  { level: NotificationLevel.MENTIONS, label: 'chat.notifyMentions' },
  { level: NotificationLevel.NONE, label: 'chat.notifyNone' },
] as const;

/**
 * «Уведомления…» in the workspace menu: one level for every room of the workspace (the server
 * stores settings per room, so this sets each; temporary mutes are kept). The mark shows the
 * level only when all rooms agree.
 */
function WorkspaceNotifyMenu({ workspaceId }: { workspaceId: string }): ReactNode {
  const roomsById = useRooms((s) => s.byId);
  const notify = useRooms((s) => s.notify);
  const rooms = useMemo(() => roomsOfWorkspace(roomsById, workspaceId), [roomsById, workspaceId]);
  if (!rooms.length) return null;
  const levels = new Set(rooms.map((r) => roomNotify(notify[r.id]).level));
  const common = levels.size === 1 ? String([...levels][0]) : '';
  const apply = (v: string): void => {
    const level: NotificationLevel = Number(v);
    for (const r of rooms) {
      const n = roomNotify(useRooms.getState().notify[r.id]);
      if (n.level !== level) void setRoomNotifications(r.id, level, n.mutedUntil);
    }
  };
  return (
    <Dropdown.Sub>
      <Dropdown.SubTrigger className={cx(menuItem, 'data-[state=open]:bg-hover')}>
        <Bell className="size-4" aria-hidden />
        <span className="flex-1">{t('shell.wsNotify')}</span>
        <ChevronRight className="size-4" aria-hidden />
      </Dropdown.SubTrigger>
      <Dropdown.Portal>
        <Dropdown.SubContent className={cx(menuBox, 'w-56')} sideOffset={4} collisionPadding={16}>
          <Dropdown.Label className={menuLabel}>{t('shell.wsNotifyAll')}</Dropdown.Label>
          <Dropdown.RadioGroup value={common} onValueChange={apply}>
            {WS_LEVELS.map((l) => (
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
        </Dropdown.SubContent>
      </Dropdown.Portal>
    </Dropdown.Sub>
  );
}

// ---------------------------------------------------------------- categories

function CategoryGroup({
  category,
  kind,
  workspaceId,
  canManage,
  onEdit,
  children,
}: {
  category: RoomCategory | null;
  /** Built-in section of a workspace without categories: no server id, no context menu. */
  kind: 'text' | 'voice' | undefined;
  workspaceId: string;
  canManage: boolean;
  onEdit: (c: RoomCategory) => void;
  children: ReactNode[];
}): ReactNode {
  const collapsed = useUi((s) => (category ? !!s.collapsed[category.id] : false));
  const toggle = useUi((s) => s.toggleCategory);
  const open = useUi((s) => s.openDialog);
  // Collapsed: keep the open room and my voice room visible (Discord behaviour).
  const activeRoom = useUi((s) => s.lastRoom[workspaceId]);
  const voiceRoom = useVoice((s) => s.roomId);
  if (!category) return <div className="mb-2 flex flex-col gap-px">{children}</div>;

  const visible = collapsed
    ? children.filter((c) => {
        const key = (c as { key?: string | null }).key;
        return key === activeRoom || key === voiceRoom;
      })
    : children;

  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('shell.categoryDelete'), t('shell.categoryDeleteConfirm', { name: category.name }), t('common.delete')))) return;
    try {
      await api.categories.remove(category.id);
    } catch (e) {
      toast.error(errText(e));
    }
  };

  const header = (
    <div className="group/cat flex h-7 items-center pr-1 pt-1">
      <button
        type="button"
        onClick={() => toggle(category.id)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('shell.categoryExpand', { name: category.name }) : t('shell.categoryCollapse', { name: category.name })}
        className="flex h-6 min-w-0 flex-1 items-center gap-0.5 rounded-[4px] pl-0.5 text-left text-micro font-semibold uppercase tracking-[0.04em] text-muted transition-colors duration-[var(--motion-fast)] hover:text-fg"
        title={category.name}
      >
        <ChevronDown className={cx('size-3 shrink-0 transition-transform duration-[var(--motion-fast)]', collapsed && '-rotate-90')} strokeWidth={2.25} aria-hidden />
        <span className="truncate">{category.name}</span>
      </button>
      {canManage ? (
        <Tip label={t('room.create')}>
          <button
            type="button"
            onClick={() => open(kind ? { kind: 'room-create', workspaceId, voice: kind === 'voice' } : { kind: 'room-create', workspaceId, voice: false, categoryId: category.id })}
            aria-label={t('shell.roomCreateIn', { name: category.name })}
            className="grid size-6 shrink-0 place-items-center rounded-[var(--radius-icon)] text-muted opacity-0 transition-opacity duration-[var(--motion-fast)] hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/cat:opacity-100"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </div>
  );

  return (
    <section className="mb-1" aria-label={category.name}>
      {canManage && !kind ? (
        <ContextMenu.Root modal={false}>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className={menuBox}>
              <ContextMenu.Item className={menuItem} onSelect={() => onEdit(category)}>
                <Pencil className="size-4" /> {t('shell.categoryRename')}
              </ContextMenu.Item>
              <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false, categoryId: category.id })}>
                <Plus className="size-4" /> {t('room.create')}
              </ContextMenu.Item>
              <ContextMenu.Separator className={menuSeparator} />
              <ContextMenu.Item className={cx(menuItem, 'text-danger-text')} onSelect={() => void remove()}>
                <Trash2 className="size-4" /> {t('shell.categoryDelete')}
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        header
      )}
      {visible.length ? <div className="mt-0.5 flex flex-col gap-px">{visible}</div> : null}
    </section>
  );
}

/** Create / rename a category (MANAGE_ROOM). */
function CategoryDialog({ workspaceId, category, onClose }: { workspaceId: string; category: RoomCategory | undefined; onClose: () => void }): ReactNode {
  const [name, setName] = useState(category?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    try {
      if (category) {
        const r = await api.categories.update(category.id, { name: v });
        if (r.category) useRooms.getState().upsertCategory(r.category);
      } else {
        const r = await api.categories.create(workspaceId, { name: v });
        if (r.category) useRooms.getState().upsertCategory(r.category);
      }
      onClose();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={category ? t('shell.categoryRename') : t('shell.categoryCreate')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {category ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('shell.categoryName')} error={error}>
          <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- room rows

/** Row shell shared by text and voice rooms: 34 px, hover background, unread pill, hover actions. */
const rowBox = 'group/row relative flex h-[34px] items-center rounded-[var(--radius-row)] transition-colors duration-[var(--motion-fast)]';

function UnreadPill({ show }: { show: boolean }): ReactNode {
  // A whole 4 × 8 pill just inside the column (a half-dot on the seam read as a glitch).
  return show ? <span aria-hidden className="absolute -left-1.5 top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-fg" /> : null;
}

function RoomActions({ room, admin, active }: { room: Room; admin: boolean; active: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  if (!admin) return null;
  const btn =
    'grid size-6 place-items-center rounded-[4px] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  return (
    <span className={cx('shrink-0 items-center gap-0.5', active ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex')}>
      <Tip label={t('shell.invite')}>
        <button
          type="button"
          className={btn}
          aria-label={t('shell.inviteTo', { name: room.name })}
          onClick={() => open({ kind: 'workspace-settings', workspaceId: room.workspaceId, tab: 'invites' })}
        >
          <UserPlus className="size-4" aria-hidden />
        </button>
      </Tip>
      <Tip label={t('room.settings')}>
        <button type="button" className={btn} aria-label={t('shell.roomSettingsOf', { name: room.name })} onClick={() => open({ kind: 'room-settings', roomId: room.id })}>
          <Settings className="size-4" aria-hidden />
        </button>
      </Tip>
    </span>
  );
}

function RoomMenu({ room, children, canManage }: { room: Room; children: ReactNode; canManage: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const last = useRooms((s) => s.lastMessage[room.id]);
  const unread = useRooms((s) => isUnread(room.id, s));
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox}>
          <ContextMenu.Item
            className={menuItem}
            disabled={!last || !unread}
            onSelect={() => {
              if (last) {
                useRooms.getState().setRead(room.id, last);
                void api.messages.markRead(room.id, last).catch(() => undefined);
              }
            }}
          >
            {t('room.markRead')}
          </ContextMenu.Item>
          {canManage ? (
            <ContextMenu.Item className={menuItem} onSelect={() => open({ kind: 'room-settings', roomId: room.id })}>
              <Settings className="size-4" /> {t('room.settings')}
            </ContextMenu.Item>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * Actions on the voice room card (Discord): the room's chat, invite, settings — 18 px icons 10 px
 * apart, shown on hover / keyboard focus (the call timer stands there otherwise).
 */
function CardActions({ room, workspaceId, canInvite, canSettings }: { room: Room; workspaceId: string; canInvite: boolean; canSettings: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const openRoom = useUi((s) => s.openRoom);
  const btn = 'grid size-6 place-items-center rounded-[var(--radius-icon)] text-muted transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-fill-hover)] hover:text-fg';
  return (
    <span className="hidden shrink-0 items-center gap-2.5 group-hover/row:flex group-focus-within/row:flex">
      <Tip label={t('shell.roomChat')}>
        <button type="button" className={btn} aria-label={t('shell.roomChatOf', { name: room.name })} onClick={() => openRoom(workspaceId, room.id)}>
          <MessageSquare className="size-[18px]" aria-hidden />
        </button>
      </Tip>
      {canInvite ? (
        <Tip label={t('shell.invite')}>
          <button type="button" className={btn} aria-label={t('shell.inviteTo', { name: room.name })} onClick={() => open({ kind: 'workspace-settings', workspaceId: room.workspaceId, tab: 'invites' })}>
            <UserPlus className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
      {canSettings ? (
        <Tip label={t('room.settings')}>
          <button type="button" className={btn} aria-label={t('shell.roomSettingsOf', { name: room.name })} onClick={() => open({ kind: 'room-settings', roomId: room.id })}>
            <Settings className="size-[18px]" aria-hidden />
          </button>
        </Tip>
      ) : null}
    </span>
  );
}

function MentionBadge({ n }: { n: number }): ReactNode {
  if (n <= 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-micro font-bold leading-4 text-white group-hover/row:hidden" aria-label={t('shell.unreadMentions', { n })}>
      {n > 99 ? '99+' : n}
    </span>
  );
}

function TextRoomRow({ room, workspaceId, me, role, admin }: { room: Room; workspaceId: string; me: string; role: WorkspaceRole; admin: boolean }): ReactNode {
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id && s.activeWorkspaceId === workspaceId);
  const openRoom = useUi((s) => s.openRoom);
  const unread = useRooms((s) => isUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const perms = roomPerms(role, me, room);
  const bright = active || unread;
  return (
    <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')}>
      <div className={cx(rowBox, active ? 'bg-active' : 'hover:bg-hover')}>
        <UnreadPill show={unread && !active} />
        <button
          type="button"
          onClick={() => openRoom(workspaceId, room.id)}
          aria-current={active ? 'page' : undefined}
          className={cx(
            'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pl-2 pr-1 text-left text-list leading-5',
            bright ? 'text-fg' : 'text-muted group-hover/row:text-fg',
            unread && !active && 'font-semibold',
          )}
        >
          {room.isPrivate ? (
            <Lock className="size-[18px] shrink-0 text-muted" aria-label={t('room.private')} />
          ) : (
            <Hash className="size-[18px] shrink-0 text-muted" aria-hidden />
          )}
          <span className="min-w-0 flex-1 truncate" title={room.name}>
            {room.name}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1 pr-1.5">
          <MentionBadge n={mentions} />
          <RoomActions room={room} admin={admin} active={active} />
        </span>
      </div>
    </RoomMenu>
  );
}

function VoiceRoomRow({
  room,
  workspaceId,
  me,
  role,
  admin,
  voiceStates,
}: {
  room: Room;
  workspaceId: string;
  me: string;
  role: WorkspaceRole;
  admin: boolean;
  voiceStates: Record<string, VoiceState>;
}): ReactNode {
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id && s.activeWorkspaceId === workspaceId);
  const openRoom = useUi((s) => s.openRoom);
  const inRoom = useVoice((s) => s.roomId === room.id);
  const connecting = useVoice((s) => s.roomId === room.id && s.phase === 'connecting');
  const unread = useRooms((s) => isUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const perms = roomPerms(role, me, room);
  const people = useMemo(
    () =>
      Object.values(voiceStates)
        .filter((v) => v.roomId === room.id)
        .sort((a, b) => Number(a.joinedAt?.seconds ?? 0n) - Number(b.joinedAt?.seconds ?? 0n) || a.userId.localeCompare(b.userId)),
    [voiceStates, room.id],
  );
  const canConnect = can(perms, 'CONNECT');
  const canMove = can(perms, 'MOVE_MEMBERS');
  const statusLine = useStatusLine(room.id, inRoom, canConnect, can(perms, 'MANAGE_ROOM'));
  const card = statusLine.shown;
  const limit = room.userLimit;
  const full = limit > 0 && people.length >= limit && !inRoom;
  const { setNodeRef, isOver, active: dragging } = useDroppable({ id: `room:${room.id}`, data: { roomId: room.id, canMove } satisfies DropRoom });
  const dragFrom = (dragging?.data.current as DragMember | undefined)?.fromRoomId;
  const dropOk = isOver && canMove && dragFrom !== room.id;

  const click = (): void => {
    openRoom(workspaceId, room.id);
    if (inRoom || !canConnect) return;
    if (full && !canMove) {
      toast.info(t('shell.roomFull'));
      return;
    }
    void voice.join(room.id, workspaceId);
  };

  return (
    <div ref={setNodeRef} className={cx('rounded-[var(--radius-card)] transition-colors duration-[var(--motion-fast)]', dropOk && 'bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] outline outline-1 outline-accent')}>
      <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')}>
        {/* With a status line the room is one raised two-line card (Discord): name + status. */}
        <div
          className={cx(
            card ? 'group/row relative flex flex-col gap-0.5 rounded-[var(--radius-card)] px-2.5 py-2' : rowBox,
            card ? (active ? 'bg-active' : 'bg-hover') : active ? 'bg-active' : 'hover:bg-hover',
          )}
          data-testid={card ? 'voice-room-card' : undefined}
        >
          <UnreadPill show={unread && !active} />
          <div className={card ? 'flex h-5 min-w-0 items-center' : 'contents'}>
            <button
              type="button"
              onClick={click}
              aria-current={active ? 'page' : undefined}
              title={canConnect ? undefined : t('voice.noConnect')}
              className={cx(
                'flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-row)] pr-1 text-left text-list leading-5',
                card ? 'pl-0' : 'pl-2',
                active || unread || inRoom ? 'text-fg' : 'text-muted group-hover/row:text-fg',
                unread && !active && 'font-semibold',
              )}
            >
              {connecting ? (
                <Loader2 className="size-[18px] shrink-0 animate-spin text-muted" aria-label={t('voice.connecting')} role="img" />
              ) : (
                <Volume2 className={cx('size-[18px] shrink-0', inRoom ? 'text-ok' : 'text-muted')} aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate" title={room.name}>
                {room.name}
              </span>
              {room.isPrivate ? <Lock className="size-3.5 shrink-0 text-muted" aria-label={t('room.private')} /> : null}
            </button>
            <span className={cx('flex shrink-0 items-center gap-1', !card && 'pr-1.5')}>
              <MentionBadge n={mentions} />
              {/* Hover or selection swaps the timer and N/M for the actions (Discord), so the name keeps ≥ 120 px. */}
              {/* Card: the timer stays on the name line (green, Discord) and gives way to the actions on hover only. */}
              <span className={cx('flex items-center gap-1', card ? 'group-hover/row:hidden group-focus-within/row:hidden' : admin && (active ? 'hidden' : 'group-hover/row:hidden group-focus-within/row:hidden'))}>
                {people.length ? <CallTimer roomId={room.id} className={card ? cx('text-[13px]', inRoom && 'text-[var(--color-green-text)]') : undefined} /> : null}
                {limit > 0 || people.length > 0 ? <PeoplePill n={people.length} max={limit} /> : null}
              </span>
              {card ? (
                <CardActions room={room} workspaceId={workspaceId} canInvite={admin} canSettings={can(perms, 'MANAGE_ROOM')} />
              ) : (
                <RoomActions room={room} admin={admin} active={active} />
              )}
            </span>
          </div>
          {card ? <VoiceStatusLine roomId={room.id} canEdit={statusLine.canEdit} status={statusLine.status} /> : null}
        </div>
      </RoomMenu>
      {inRoom && can(perms, 'MANAGE_ROOM') ? <VoiceInviteRow roomId={room.id} /> : null}
      {people.length > 0 ? (
        <ul className="flex flex-col gap-px pb-1 pt-0.5" aria-label={room.name}>
          {people.map((v) => (
            <VoiceMember
              key={v.userId}
              state={v}
              room={room}
              workspaceId={workspaceId}
              isMe={v.userId === me}
              canMove={canMove}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * People in a voice room: one muted pill with the people icon — «2/4» with a limit (red when
 * full), «2» without one. The call timer stands apart from it (review: «02 | 04» read as noise).
 */
function PeoplePill({ n, max }: { n: number; max: number }): ReactNode {
  const full = max > 0 && n >= max;
  return (
    <span
      // Primary text on the fill: muted grey fell under 4.5:1 on the selected card (axe).
      className={cx('flex items-center gap-0.5 rounded-full bg-[var(--color-fill)] py-px pl-1 pr-1.5 text-micro font-medium tabular-nums leading-4', full ? 'text-danger-text' : 'text-fg')}
      aria-label={max > 0 ? t('shell.userLimit', { n, max }) : t('shell.peopleIn', { n })}
      role="img"
      data-testid="room-limit"
    >
      <Users className="size-3" aria-hidden />
      {max > 0 ? limitLabel(n, max) : n}
    </span>
  );
}

export function CallTimer({ roomId, className }: { roomId: string; className?: string }): ReactNode {
  // Room.voice_started_at from the server (READY snapshot + ROOM_UPDATE); unset = no call.
  const startedAt = useRooms((s) => s.byId[roomId]?.voiceStartedAt);
  const now = useNow();
  if (!startedAt) return null;
  const text = formatDuration(Math.max(0, now - timestampMs(startedAt)));
  return (
    <span className={cx('text-micro tabular-nums text-fg', className)} aria-label={t('shell.callTime', { time: text })}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- voice participants

function VoiceMember({
  state,
  room,
  workspaceId,
  isMe,
  canMove,
}: {
  state: VoiceState;
  room: Room;
  workspaceId: string;
  isMe: boolean;
  canMove: boolean;
}): ReactNode {
  const speaking = useVoice((s) => s.speaking[state.userId] ?? false);
  const inSameRoom = useVoice((s) => s.roomId === room.id);
  // Only our own moderator mute is known (VoiceState has no server-mute flag yet).
  const serverMuted = useVoice((s) => s.serverMuted);
  const stream = useVoice((s) => s.streams.find((x) => x.userId === state.userId));
  const user = useWorkspaces((s) => s.users[state.userId]);
  const name = useWorkspaces(() => memberName(workspaceId, state.userId));
  // «(+5 UTC)» when their time zone differs from mine (User.timezone).
  const tz = useTimeZoneLabel(state.userId);
  const [profileOpen, setProfileOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const talking = speaking && !state.muted;
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({
    id: `member:${room.id}:${state.userId}`,
    data: { userId: state.userId, fromRoomId: room.id, name } satisfies DragMember,
    disabled: !canMove,
  });

  const row = (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      // Pointer drag only (the context menu «Переместить в…» is the keyboard path): keep list
      // semantics instead of dnd-kit's role="button"; focusable for the context menu key.
      role="listitem"
      aria-roledescription={undefined}
      tabIndex={0}
      aria-label={canMove ? `${name}. ${t('shell.dragHint')}` : name}
      onClick={() => {
        if (stream && inSameRoom) voice.watch(stream.trackSid);
      }}
      className={cx(
        // Discord: 36 px rows, 32 px avatars aligned with the room name, 15 px names.
        'group/member flex h-9 items-center gap-2 rounded-[var(--radius-row)] pl-[34px] pr-1.5 text-list transition-colors duration-[var(--motion-fast)] hover:bg-hover',
        canMove ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        isDragging && 'opacity-40',
      )}
      title={name}
    >
      <Avatar userId={state.userId} name={name} fileId={user?.avatarFileId || undefined} size={32} speaking={talking} />
      <span className={cx('min-w-0 flex-1 truncate', talking || isMe ? 'text-fg' : 'text-muted group-hover/member:text-fg')}>
        {name}
        {tz ? <span className="text-muted"> {tz}</span> : null}
      </span>
      {state.streaming ? (
        <Badge tone="danger" title={t('voice.streaming')}>
          {t('shell.live')}
        </Badge>
      ) : null}
      {state.camera ? <Video className="size-4 shrink-0 text-muted" aria-label={t('video.stateOn')} role="img" /> : null}
      <VoiceStateIcons muted={state.muted} deafened={state.deafened} serverMuted={state.serverMuted || (isMe && serverMuted)} />
    </li>
  );
  // Shared member menu (PEOPLE): profile, mention, volume, moderation, «Переместить в ›»… The
  // «Профиль» item opens the same profile card as the members column, next to the row.
  return (
    <Popover.Root open={profileOpen} onOpenChange={setProfileOpen}>
      <MemberContextMenu workspaceId={workspaceId} userId={state.userId} onOpenProfile={() => setProfileOpen(true)}>
        <Popover.Anchor asChild>{row}</Popover.Anchor>
      </MemberContextMenu>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="mat-popover dense anim-in z-[var(--z-popover)] rounded-[var(--radius-panel)] text-fg focus:outline-none"
          aria-label={name}
        >
          <ProfileCard
            workspaceId={workspaceId}
            userId={state.userId}
            onRename={() => {
              setProfileOpen(false);
              setRenaming(true);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
      {renaming ? <NicknameDialog workspaceId={workspaceId} userId={state.userId} onClose={() => setRenaming(false)} /> : null}
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- drag & drop (docs/09 #32)

function VoiceDnd({ workspaceId, children }: { workspaceId: string; children: ReactNode }): ReactNode {
  // 6 px before a drag starts: a click on a participant stays a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragged, setDragged] = useState<DragMember | null>(null);
  const [blocked, setBlocked] = useState(false);

  // «Not allowed» cursor over a room where I cannot move members; grabbing otherwise.
  useEffect(() => {
    if (!dragged) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = blocked ? 'not-allowed' : 'grabbing';
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragged, blocked]);

  const onStart = (e: DragStartEvent): void => {
    setDragged((e.active.data.current as DragMember | undefined) ?? null);
    setBlocked(false);
  };
  const onOver = (e: DragOverEvent): void => {
    const target = e.over?.data.current as DropRoom | undefined;
    const from = (e.active.data.current as DragMember | undefined)?.fromRoomId;
    setBlocked(!!target && target.roomId !== from && !target.canMove);
  };
  const onEnd = (e: DragEndEvent): void => {
    setDragged(null);
    setBlocked(false);
    const m = e.active.data.current as DragMember | undefined;
    const target = e.over?.data.current as DropRoom | undefined;
    if (!m || !target || target.roomId === m.fromRoomId) return;
    if (!target.canMove) {
      toast.info(t('shell.moveNotAllowed'));
      return;
    }
    moveMember(workspaceId, m.fromRoomId, m.userId, target.roomId);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setDragged(null)}>
      {children}
      <DragOverlay dropAnimation={null}>{dragged ? <DragChip member={dragged} /> : null}</DragOverlay>
    </DndContext>
  );
}

function DragChip({ member }: { member: DragMember }): ReactNode {
  const user = useWorkspaces((s) => s.users[member.userId]);
  return (
    <div className="mat-popover flex h-8 w-max max-w-[220px] items-center gap-2 rounded-full pl-1 pr-3 text-body font-medium">
      <Avatar userId={member.userId} name={member.name} fileId={user?.avatarFileId || undefined} size={24} />
      <span className="truncate">{member.name}</span>
    </div>
  );
}
