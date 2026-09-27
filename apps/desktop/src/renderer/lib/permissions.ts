import {
  PERMISSION_BITS,
  PermissionTargetType,
  RoomType,
  computeMemberRoomPermissions,
  computePermissions,
  WorkspaceRole,
  has,
  workspacePermissions,
  type PermissionBits,
  type PermissionName,
  type RoleBits,
  type Room,
  type RoomPermissionOverride,
} from '@calaba/protocol';

/**
 * UI permission helpers on top of `computePermissions` (packages/protocol). Since ADR-0026 a
 * member holds several roles: callers pass them (`rolesOf` / `useMemberRoles` in
 * stores/workspaces). The client only hides UI; every action is checked by the server (CLAUDE.md).
 */

export function roomPerms(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): PermissionBits {
  // A DM (ADR-0020): the fixed set; the client only knows DMs it takes part in.
  if (room?.type === RoomType.DM) return computePermissions({ dm: { participant: true } });
  if (!room || !roles || roles.length === 0) return 0n;
  return computeMemberRoomPermissions(roles, userId, room.permissionOverrides);
}

/** Workspace-level permissions (no room overrides): the OR of the member's roles. */
export function workspacePerms(roles: readonly RoleBits[] | undefined): PermissionBits {
  return roles ? workspacePermissions(roles) : 0n;
}

export function can(perms: PermissionBits, name: PermissionName): boolean {
  return has(perms, PERMISSION_BITS[name]);
}

/**
 * Rooms and categories: create, rename, reorder (drag & drop, «Переместить вверх / вниз») —
 * workspace-level MANAGE_ROOM of my roles (owner / admins: ADMINISTRATOR = everything).
 */
export function mayArrangeRooms(roles: readonly RoleBits[] | undefined): boolean {
  return can(workspacePerms(roles), 'MANAGE_ROOM');
}

/**
 * Workspace management (settings, media defaults, invites, bans, GPTunneL, a room's
 * allow_recording): workspace-level MANAGE_WORKSPACE of my roles — the server's check. A custom
 * role with MANAGE_WORKSPACE gets it too, not only the built-in owner / admins.
 */
export function mayManageWorkspace(roles: readonly RoleBits[] | undefined): boolean {
  return can(workspacePerms(roles), 'MANAGE_WORKSPACE');
}

const voiceRank = (r: WorkspaceRole | undefined): number => (r === WorkspaceRole.OWNER ? 3 : r === WorkspaceRole.ADMIN ? 2 : 1);

/**
 * Voice moderation hierarchy (server rtc.outranks): mute, disconnect, stop a stream / camera and
 * move another member only below the owner / admins by built-in role — the owner is untouchable,
 * an admin is moderated by the owner only; members and guests by anyone with the bit. Oneself: yes.
 */
export function mayModerateVoice(myRole: WorkspaceRole | undefined, targetRole: WorkspaceRole | undefined, self: boolean): boolean {
  if (self) return true;
  const t = voiceRank(targetRole);
  return t < 2 || voiceRank(myRole) > t;
}

/** Drag a voice participant out of / into `room` (docs/09 #32): MOVE_MEMBERS in that room. */
export function mayMoveMembersIn(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return can(roomPerms(roles, userId, room), 'MOVE_MEMBERS');
}

/**
 * The call's «Демонстрация» / «Камера» gates from my rights in the room (UI only: the server
 * re-checks STREAM + a free slot in /stream/request, VIDEO + camera_limit in /camera/request).
 * Used for a move (no /join answer) and whenever my roles or the room's overrides change during
 * a call — the /join answer is not refreshed by the server.
 */
export function voiceCaps(perms: PermissionBits, room: Pick<Room, 'media'> | undefined): { canStream: boolean; canVideo: boolean } {
  return { canStream: can(perms, 'STREAM'), canVideo: can(perms, 'VIDEO') && (room?.media?.cameraLimit ?? 0) > 0 };
}

/** Pin / unpin: MANAGE_MESSAGES, or either participant of a DM (by room type, docs/04). */
export function mayPin(perms: PermissionBits, room: Pick<Room, 'type'> | undefined): boolean {
  return can(perms, 'MANAGE_MESSAGES') || room?.type === RoomType.DM;
}

/** May this author's @everyone / @here in the room notify people (MENTION_EVERYONE)? */
export function mayMentionAll(roles: readonly RoleBits[] | undefined, userId: string, room: Room | undefined): boolean {
  return can(roomPerms(roles, userId, room), 'MENTION_EVERYONE');
}

export const isAdminRole = (role: WorkspaceRole | undefined): boolean =>
  role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;

// ---------------------------------------------------------------- permission editor

export type Tri = 'allow' | 'deny' | 'inherit';

export interface OverrideDraft {
  targetType: PermissionTargetType;
  targetId: string;
  allow: bigint;
  deny: bigint;
}

export function triOf(o: Pick<OverrideDraft, 'allow' | 'deny'> | undefined, bit: bigint): Tri {
  if (!o) return 'inherit';
  if (o.allow & bit) return 'allow';
  if (o.deny & bit) return 'deny';
  return 'inherit';
}

export function withTri<T extends Pick<OverrideDraft, 'allow' | 'deny'>>(o: T, bit: bigint, v: Tri): T {
  const allow = v === 'allow' ? o.allow | bit : o.allow & ~bit;
  const deny = v === 'deny' ? o.deny | bit : o.deny & ~bit;
  return { ...o, allow, deny };
}

/** Next state when clicking a tri-state cell: inherit → allow → deny → inherit. */
export function cycleTri(v: Tri): Tri {
  return v === 'inherit' ? 'allow' : v === 'allow' ? 'deny' : 'inherit';
}

export function toDrafts(list: readonly RoomPermissionOverride[]): OverrideDraft[] {
  return list.map((o) => ({ targetType: o.targetType, targetId: o.targetId, allow: o.allow, deny: o.deny }));
}

/** Drops empty overrides before PUT /api/rooms/{id}/permissions. */
export function compactDrafts(list: readonly OverrideDraft[]): OverrideDraft[] {
  return list.filter((o) => o.allow !== 0n || o.deny !== 0n);
}

/** Permission bits editable per room (workspace-level ones make no sense on a room). */
export const ROOM_EDITABLE: PermissionName[] = [
  'VIEW_ROOM',
  'SEND_MESSAGES',
  'ATTACH_FILES',
  'MANAGE_MESSAGES',
  'CONNECT',
  'SPEAK',
  'STREAM',
  'VIDEO',
  'MUTE_MEMBERS',
  'MOVE_MEMBERS',
  'MENTION_EVERYONE',
  'MANAGE_ROOM',
];
