import {
  PresenceStatus,
  RoomType,
  WorkspaceRole,
  type Presence,
  type Room,
  type VoiceState,
  type WorkspaceMember,
} from '@calaba/protocol';
import { can, roomPerms, workspacePerms } from '../../lib/permissions';

/*
 * Pure people logic (members column grouping, member context-menu availability). The client
 * only hides UI: the server re-checks every action (CLAUDE.md).
 */

export const isOnline = (s: PresenceStatus | undefined): boolean =>
  s === PresenceStatus.ONLINE || s === PresenceStatus.IDLE || s === PresenceStatus.DND;

/** Display order of roles: owner, admins, members, guests. */
export function roleRank(r: WorkspaceRole): number {
  switch (r) {
    case WorkspaceRole.OWNER:
      return 0;
    case WorkspaceRole.ADMIN:
      return 1;
    case WorkspaceRole.GUEST:
      return 3;
    default:
      return 2;
  }
}

export const nameOf = (m: WorkspaceMember): string => m.nickname || m.user?.displayName || '';

export interface MemberGroups {
  online: WorkspaceMember[];
  offline: WorkspaceMember[];
}

/**
 * «В сети» / «Не в сети» (docs/09 #12), each sorted by role (owner → admins → members →
 * guests), then name. Someone in voice counts as online even if their presence lags.
 */
export function groupMembers(
  members: readonly WorkspaceMember[],
  presences: Readonly<Record<string, Presence | undefined>>,
  voice: Readonly<Record<string, VoiceState | undefined>> = {},
): MemberGroups {
  const list = members.filter((m) => m.user);
  list.sort((a, b) => roleRank(a.role) - roleRank(b.role) || nameOf(a).localeCompare(nameOf(b), 'ru'));
  const on = (m: WorkspaceMember): boolean => {
    const id = m.user?.id ?? '';
    return isOnline(presences[id]?.status) || !!voice[id]?.roomId;
  };
  return { online: list.filter(on), offline: list.filter((m) => !on(m)) };
}

// ---------------------------------------------------------------- context menu

export interface MenuContext {
  meId: string;
  myRole: WorkspaceRole | undefined;
  target: WorkspaceMember;
  /** Target's aggregated voice state in this workspace (room_id set = in voice). */
  targetVoice: VoiceState | undefined;
  /** LiveKit room I am connected to (volume is per remote participant of my room). */
  myVoiceRoomId: string | null;
  /** Rooms of the workspace visible to me. */
  rooms: readonly Room[];
  allowSelfNickname: boolean;
}

export interface MenuActions {
  volume: boolean;
  serverMute: boolean;
  /** Already server/self-muted: the item is shown disabled. */
  alreadyMuted: boolean;
  /** «Включить микрофон»: the member is muted by a moderator (VoiceState.server_muted). */
  serverUnmute: boolean;
  disconnect: boolean;
  /** «Не показывать видео»: the target's camera is on in my voice room. */
  hideVideo: boolean;
  /** Moderator «Выключить камеру» (MUTE_MEMBERS in the room; VoiceState.camera). */
  stopCamera: boolean;
  /** Voice rooms the target can be moved to (empty = no «Переместить в…»). */
  moveTargets: Room[];
  rename: boolean;
  promote: boolean;
  removeGuest: boolean;
  kick: boolean;
}

export function memberActions(c: MenuContext): MenuActions {
  const userId = c.target.user?.id ?? '';
  const self = userId === c.meId;
  const ws = workspacePerms(c.myRole);
  const inRoom = c.targetVoice?.roomId ? c.rooms.find((r) => r.id === c.targetVoice?.roomId) : undefined;
  const permsIn = (r: Room): bigint => roomPerms(c.myRole, c.meId, r);
  // Disconnect / stop-stream honour the room override; server mute needs MUTE_MEMBERS at the
  // workspace level (owner/admin) — a room grant cannot silence someone everywhere.
  const moderate = !self && !!inRoom && can(permsIn(inRoom), 'MUTE_MEMBERS');
  const muteAll = moderate && can(ws, 'MUTE_MEMBERS');
  const canMoveFrom = !self && !!inRoom && can(permsIn(inRoom), 'MOVE_MEMBERS');
  const moveTargets = canMoveFrom
    ? c.rooms.filter((r) => r.type === RoomType.VOICE && r.id !== inRoom.id && can(permsIn(r), 'MOVE_MEMBERS'))
    : [];
  const manage = can(ws, 'MANAGE_WORKSPACE');
  const guest = c.target.role === WorkspaceRole.GUEST;
  const removable =
    !self &&
    manage &&
    c.target.role !== WorkspaceRole.OWNER &&
    (c.target.role !== WorkspaceRole.ADMIN || c.myRole === WorkspaceRole.OWNER);
  return {
    volume: !self && !!c.myVoiceRoomId && c.targetVoice?.roomId === c.myVoiceRoomId,
    serverMute: muteAll,
    alreadyMuted: !!c.targetVoice?.serverMuted,
    serverUnmute: muteAll && !!c.targetVoice?.serverMuted,
    disconnect: moderate,
    hideVideo: !self && !!c.myVoiceRoomId && c.targetVoice?.roomId === c.myVoiceRoomId && c.targetVoice.camera,
    stopCamera: moderate && !!c.targetVoice?.camera,
    moveTargets,
    rename: self ? c.allowSelfNickname || can(ws, 'MANAGE_NICKNAMES') : can(ws, 'MANAGE_NICKNAMES'),
    promote: manage && guest && !self,
    removeGuest: removable && guest,
    kick: removable && !guest,
  };
}

export function hasAnyAction(a: MenuActions): boolean {
  return a.volume || a.serverMute || a.disconnect || a.hideVideo || a.stopCamera || a.moveTargets.length > 0 || a.rename || a.promote || a.removeGuest || a.kick;
}
