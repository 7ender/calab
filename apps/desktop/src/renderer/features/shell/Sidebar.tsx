import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { WorkspaceRole, type Room, type VoiceState } from '@calaba/protocol';
import { ChevronDown, Hash, HeadphoneOff, Lock, LogOut, MicOff, MonitorUp, Plus, Settings, UserPlus, Volume2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Slider, Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { can, isAdminRole, roomPerms } from '../../lib/permissions';
import { voice } from '../../services/voice';
import { usePrefs } from '../../stores/prefs';
import { isUnread, isVoice, roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { SelfPanel } from './SelfPanel';
import { VoiceBar } from './VoiceBar';

/** macOS-style menus: popover material, 24 px items, accent highlight. */
const menuItem =
  'flex h-7 cursor-default items-center gap-2 rounded-[5px] px-2 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg';
const menuBox = 'mat-popover anim-in z-[var(--z-popover)] min-w-52 rounded-[var(--radius-card)] p-1';

export { menuBox, menuItem };

export function Sidebar({ workspaceId }: { workspaceId: string }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const roomsById = useRooms((s) => s.byId);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const open = useUi((s) => s.openDialog);
  const rooms = useMemo(() => roomsOfWorkspace(roomsById, workspaceId), [roomsById, workspaceId]);
  if (!entry) return null;
  const admin = isAdminRole(entry.role);
  const text = rooms.filter((r) => !isVoice(r));
  const voiceRooms = rooms.filter((r) => isVoice(r));

  const leave = async (): Promise<void> => {
    if (!(await confirmAction(t('ws.leave'), t('ws.leaveConfirm', { name: entry.ws.name }), t('ws.leave')))) return;
    try {
      await api.workspaces.removeMember(workspaceId, '@me');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <aside className="mat-sidebar flex w-[var(--sidebar-width)] shrink-0 flex-col" aria-label={t('room.list')}>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            className="drag flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4 text-[14px] font-semibold hover:bg-hover"
            title={entry.ws.name}
          >
            <span className="no-drag min-w-0 truncate">{entry.ws.name}</span>
            <ChevronDown className="no-drag size-4 shrink-0 text-muted" strokeWidth={1.75} aria-hidden />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className={menuBox} sideOffset={4} align="start">
            {admin ? (
              <>
                <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'invites' })}>
                  <UserPlus className="size-4" /> {t('ws.invite')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId })}>
                  <Settings className="size-4" /> {t('ws.settings')}
                </Dropdown.Item>
                <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'room-create', workspaceId, voice: false })}>
                  <Plus className="size-4" /> {t('room.create')}
                </Dropdown.Item>
              </>
            ) : (
              <Dropdown.Item className={menuItem} onSelect={() => open({ kind: 'workspace-settings', workspaceId, tab: 'members' })}>
                <Settings className="size-4" /> {t('ws.members')}
              </Dropdown.Item>
            )}
            {entry.role !== WorkspaceRole.OWNER ? (
              <>
                <Dropdown.Separator className="my-1 h-px bg-line" />
                <Dropdown.Item className={cx(menuItem, 'text-danger')} onSelect={() => void leave()}>
                  <LogOut className="size-4" /> {t('ws.leave')}
                </Dropdown.Item>
              </>
            ) : null}
          </Dropdown.Content>
        </Dropdown.Portal>
      </Dropdown.Root>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <Section title={t('room.textRooms')} onAdd={admin ? () => open({ kind: 'room-create', workspaceId, voice: false }) : undefined}>
          {text.map((r) => (
            <TextRoomRow key={r.id} room={r} workspaceId={workspaceId} me={me} role={entry.role} />
          ))}
        </Section>
        <Section title={t('room.voiceRooms')} onAdd={admin ? () => open({ kind: 'room-create', workspaceId, voice: true }) : undefined}>
          {voiceRooms.map((r) => (
            <VoiceRoomRow key={r.id} room={r} workspaceId={workspaceId} me={me} role={entry.role} voiceStates={entry.voice} />
          ))}
        </Section>
      </div>
      <VoiceBar />
      <SelfPanel />
    </aside>
  );
}

function Section({ title, onAdd, children }: { title: string; onAdd: (() => void) | undefined; children: ReactNode }): ReactNode {
  return (
    <div className="mb-4">
      <div className="group flex h-6 items-center justify-between px-2">
        <h2 className="truncate text-[11px] font-semibold text-faint">{title}</h2>
        {onAdd ? (
          <Tip label={t('room.create')}>
            <button type="button" onClick={onAdd} className="grid size-6 place-items-center rounded-[var(--radius-control)] text-faint hover:bg-hover hover:text-fg" aria-label={t('room.create')}>
              <Plus className="size-4" strokeWidth={1.75} />
            </button>
          </Tip>
        ) : null}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

function RoomMenu({ room, children, canManage }: { room: Room; children: ReactNode; canManage: boolean }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const last = useRooms((s) => s.lastMessage[room.id]);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuBox}>
          <ContextMenu.Item
            className={menuItem}
            disabled={!last}
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

function TextRoomRow({ room, workspaceId, me, role }: { room: Room; workspaceId: string; me: string; role: WorkspaceRole }): ReactNode {
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id);
  const openRoom = useUi((s) => s.openRoom);
  const unread = useRooms((s) => isUnread(room.id, s));
  const mentions = useRooms((s) => s.mentions[room.id] ?? 0);
  const perms = roomPerms(role, me, room);
  return (
    <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')}>
      <button
        type="button"
        onClick={() => openRoom(workspaceId, room.id)}
        className={cx(
          'group flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-[13px]',
          active ? 'bg-active text-fg' : unread ? 'text-fg hover:bg-hover' : 'text-muted hover:bg-hover hover:text-fg',
        )}
      >
        <Hash className="size-4 shrink-0 text-faint" strokeWidth={1.75} aria-hidden />
        <span className={cx('min-w-0 flex-1 truncate', unread && !active && 'font-semibold text-fg')} title={room.name}>{room.name}</span>
        {room.isPrivate ? <Lock className="size-3 shrink-0 text-faint" strokeWidth={1.75} aria-label={t('room.private')} /> : null}
        {mentions > 0 ? <span className="shrink-0 rounded-full bg-danger-fill px-1.5 text-[11px] font-semibold text-white">{mentions}</span> : null}
      </button>
    </RoomMenu>
  );
}

function VoiceRoomRow({
  room,
  workspaceId,
  me,
  role,
  voiceStates,
}: {
  room: Room;
  workspaceId: string;
  me: string;
  role: WorkspaceRole;
  voiceStates: Record<string, VoiceState>;
}): ReactNode {
  const active = useUi((s) => s.lastRoom[workspaceId] === room.id);
  const openRoom = useUi((s) => s.openRoom);
  const inRoom = useVoice((s) => s.roomId === room.id);
  const unread = useRooms((s) => isUnread(room.id, s));
  const perms = roomPerms(role, me, room);
  const people = Object.values(voiceStates).filter((v) => v.roomId === room.id);
  const canConnect = can(perms, 'CONNECT');

  const click = (): void => {
    openRoom(workspaceId, room.id);
    if (!inRoom && canConnect) void voice.join(room.id, workspaceId);
  };

  return (
    <div>
      <RoomMenu room={room} canManage={can(perms, 'MANAGE_ROOM')}>
        <button
          type="button"
          onClick={click}
          title={canConnect ? undefined : t('voice.noConnect')}
          className={cx(
            'flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-[13px]',
            active ? 'bg-active text-fg' : 'text-muted hover:bg-hover hover:text-fg',
          )}
        >
          <Volume2 className={cx('size-4 shrink-0', inRoom ? 'text-ok' : 'text-faint')} strokeWidth={1.75} aria-hidden />
          <span className={cx('min-w-0 flex-1 truncate', unread && !active && 'font-semibold text-fg')} title={room.name}>{room.name}</span>
          {room.isPrivate ? <Lock className="size-3 shrink-0 text-faint" strokeWidth={1.75} aria-label={t('room.private')} /> : null}
        </button>
      </RoomMenu>
      {people.length > 0 ? (
        <div className="ml-6 flex flex-col gap-px py-0.5">
          {people.map((v) => (
            <VoiceMember key={v.userId} state={v} room={room} workspaceId={workspaceId} isMe={v.userId === me} canModerate={can(perms, 'MUTE_MEMBERS')} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function VoiceMember({
  state,
  room,
  workspaceId,
  isMe,
  canModerate,
}: {
  state: VoiceState;
  room: Room;
  workspaceId: string;
  isMe: boolean;
  canModerate: boolean;
}): ReactNode {
  const speaking = useVoice((s) => s.speaking[state.userId] ?? false);
  const inSameRoom = useVoice((s) => s.roomId === room.id);
  const volume = usePrefs((s) => s.userVolumes[state.userId] ?? 1);
  const user = useWorkspaces((s) => s.users[state.userId]);
  const name = memberName(workspaceId, state.userId);
  const row = (
    <div className="flex h-7 items-center gap-2 rounded-[var(--radius-control)] px-2 text-[13px] text-muted hover:bg-hover hover:text-fg" title={name}>
      <Avatar userId={state.userId} name={name} fileId={user?.avatarFileId || undefined} size={20} speaking={speaking && !state.muted} />
      <span className={cx('min-w-0 flex-1 truncate', speaking && !state.muted && 'text-fg')}>{name}</span>
      {state.streaming ? (
        <span className="shrink-0 rounded-[4px] bg-danger-fill px-1 text-[10px] font-semibold uppercase text-white" title={t('voice.streaming')}>
          live
        </span>
      ) : null}
      {state.deafened ? <HeadphoneOff className="size-3.5 text-danger" /> : state.muted ? <MicOff className="size-3.5 text-danger" /> : null}
      {state.streaming && !isMe ? <MonitorUp className="size-3.5 text-faint" /> : null}
    </div>
  );
  if (isMe && !canModerate) return row;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{row}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cx(menuBox, 'w-60')}>
          <div className="px-2 py-1 text-[12px] font-semibold text-muted">{name}</div>
          {!isMe && inSameRoom ? (
            <div className="px-2 py-2">
              <div className="mb-1 flex justify-between text-[12px] text-muted">
                <span>{t('voice.userVolume')}</span>
                <span>{Math.round(volume * 100)}%</span>
              </div>
              <Slider label={t('voice.userVolume')} value={volume} min={0} max={1} step={0.01} onChange={(v) => voice.setUserVolume(state.userId, v)} />
            </div>
          ) : null}
          {canModerate && !isMe ? (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-line" />
              <ContextMenu.Item
                className={menuItem}
                disabled={!inSameRoom || state.muted}
                onSelect={() => void voice.serverMute(state.userId).catch((e: unknown) => toast.error(String(e)))}
              >
                <MicOff className="size-4" /> {t('voice.serverMute')}
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cx(menuItem, 'text-danger')}
                onSelect={() => void voice.serverDisconnect(room.id, state.userId).catch((e: unknown) => toast.error(String(e)))}
              >
                <LogOut className="size-4" /> {t('voice.kick')}
              </ContextMenu.Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
