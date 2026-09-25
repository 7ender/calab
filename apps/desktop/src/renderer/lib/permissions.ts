import {
  PERMISSION_BITS,
  PermissionTargetType,
  ROLE_DEFAULTS,
  WorkspaceRole,
  computeRoomPermissions,
  has,
  type PermissionBits,
  type PermissionName,
  type Room,
  type RoomPermissionOverride,
} from '@calaba/protocol';

/**
 * UI permission helpers on top of `computePermissions` (packages/protocol).
 * The client only hides UI; every action is checked by the server (CLAUDE.md).
 */

export function roomPerms(role: WorkspaceRole | undefined, userId: string, room: Room | undefined): PermissionBits {
  if (!room || role === undefined) return 0n;
  return computeRoomPermissions(role, userId, room.permissionOverrides);
}

/** Workspace-level permissions (no room overrides): role defaults. */
export function workspacePerms(role: WorkspaceRole | undefined): PermissionBits {
  if (role === undefined) return 0n;
  const base = ROLE_DEFAULTS[role];
  return base & PERMISSION_BITS.ADMINISTRATOR ? Object.values(PERMISSION_BITS).reduce((a, b) => a | b, 0n) : base;
}

export function can(perms: PermissionBits, name: PermissionName): boolean {
  return has(perms, PERMISSION_BITS[name]);
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
  'MUTE_MEMBERS',
  'MANAGE_ROOM',
];
