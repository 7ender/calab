import { Permission, WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, type RoomPermissionOverride } from './gen/calaba/v1/room_pb.js';

/**
 * Permission bits as bigint (uint64 on the wire). Values come from the generated
 * `Permission` enum (proto/calaba/v1/permissions.proto) — see docs/04-data-model.md, ADR-0008.
 */
export const PERMISSION_BITS = {
  VIEW_ROOM: BigInt(Permission.VIEW_ROOM),
  SEND_MESSAGES: BigInt(Permission.SEND_MESSAGES),
  ATTACH_FILES: BigInt(Permission.ATTACH_FILES),
  MANAGE_MESSAGES: BigInt(Permission.MANAGE_MESSAGES),
  CONNECT: BigInt(Permission.CONNECT),
  SPEAK: BigInt(Permission.SPEAK),
  STREAM: BigInt(Permission.STREAM),
  MUTE_MEMBERS: BigInt(Permission.MUTE_MEMBERS),
  MANAGE_ROOM: BigInt(Permission.MANAGE_ROOM),
  MANAGE_WORKSPACE: BigInt(Permission.MANAGE_WORKSPACE),
  ADMINISTRATOR: BigInt(Permission.ADMINISTRATOR),
  MOVE_MEMBERS: BigInt(Permission.MOVE_MEMBERS),
  MANAGE_NICKNAMES: BigInt(Permission.MANAGE_NICKNAMES),
  MENTION_EVERYONE: BigInt(Permission.MENTION_EVERYONE),
  VIDEO: BigInt(Permission.VIDEO),
  MANAGE_ROLES: BigInt(Permission.MANAGE_ROLES),
  MANAGE_STICKERS: BigInt(Permission.MANAGE_STICKERS),
  VIEW_BOARD: BigInt(Permission.VIEW_BOARD),
  CREATE_TASKS: BigInt(Permission.CREATE_TASKS),
  EDIT_TASKS: BigInt(Permission.EDIT_TASKS),
  MANAGE_BOARD: BigInt(Permission.MANAGE_BOARD),
} as const;

export type PermissionName = keyof typeof PERMISSION_BITS;
export type PermissionBits = bigint;

export const ALL_PERMISSIONS: PermissionBits = Object.values(PERMISSION_BITS).reduce((a, b) => a | b, 0n);

const {
  VIEW_ROOM,
  SEND_MESSAGES,
  ATTACH_FILES,
  CONNECT,
  SPEAK,
  STREAM,
  VIDEO,
  ADMINISTRATOR,
  VIEW_BOARD,
  CREATE_TASKS,
} = PERMISSION_BITS;

/**
 * Bits of task boards (ADR-0042): board overrides touch only them, room overrides never do
 * (Go: perm.BoardOnly).
 */
export const BOARD_ONLY_PERMISSIONS: PermissionBits =
  VIEW_BOARD | CREATE_TASKS | PERMISSION_BITS.EDIT_TASKS | PERMISSION_BITS.MANAGE_BOARD;

/**
 * Bits room overrides may touch. ADMINISTRATOR, MANAGE_WORKSPACE, MANAGE_NICKNAMES, MANAGE_ROLES
 * and MANAGE_STICKERS are workspace-level, the board bits apply to boards only: computePermissions
 * ignores them in room overrides (Go: perm.RoomOnly).
 */
export const ROOM_ONLY_PERMISSIONS: PermissionBits =
  ALL_PERMISSIONS &
  ~(
    ADMINISTRATOR |
    PERMISSION_BITS.MANAGE_WORKSPACE |
    PERMISSION_BITS.MANAGE_NICKNAMES |
    PERMISSION_BITS.MANAGE_ROLES |
    PERMISSION_BITS.MANAGE_STICKERS |
    BOARD_ONLY_PERMISSIONS
  );

/** Initial permissions of the built-in roles (the member / guest roles are editable since ADR-0026). */
export const ROLE_DEFAULTS: Record<WorkspaceRole, PermissionBits> = {
  [WorkspaceRole.UNSPECIFIED]: 0n,
  [WorkspaceRole.OWNER]: ADMINISTRATOR,
  [WorkspaceRole.ADMIN]: ADMINISTRATOR,
  [WorkspaceRole.MEMBER]:
    VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | CONNECT | SPEAK | STREAM | VIDEO | VIEW_BOARD | CREATE_TASKS,
  // Guests see only rooms with an explicit VIEW_ROOM allow override.
  [WorkspaceRole.GUEST]: CONNECT | SPEAK,
};

/**
 * Fixed permissions of both participants of a direct message (ADR-0020). Roles and
 * overrides do not apply. Reading history = VIEW_ROOM, reactions need SEND_MESSAGES,
 * editing/deleting own messages is the author's right; pinning is allowed to both
 * participants by room type (no MANAGE_MESSAGES: no moderation in DMs).
 */
export const DM_PERMISSIONS: PermissionBits = VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES;

/** Fixed positions of the built-in roles (ADR-0026); custom roles sit in between (2..). */
export const BUILTIN_ROLE_POSITION: Record<WorkspaceRole, number> = {
  [WorkspaceRole.UNSPECIFIED]: -1,
  [WorkspaceRole.OWNER]: 1001,
  [WorkspaceRole.ADMIN]: 1000,
  [WorkspaceRole.MEMBER]: 1,
  [WorkspaceRole.GUEST]: 0,
};

/**
 * A role as far as permissions are concerned; the generated `Role` fits it
 * (id, position, permissions). Higher position = more senior.
 */
export interface RoleBits {
  id: string;
  position: number;
  permissions: PermissionBits;
  /** Built-in role key (generated Role.builtin); the holder of OWNER is the workspace owner. */
  builtin?: WorkspaceRole | undefined;
}

/** Structural allow/deny pair; the generated PermissionOverride / RoomPermissionOverride fit it. */
export interface OverrideBits {
  allow: PermissionBits;
  deny: PermissionBits;
}

export interface ComputePermissionsInput {
  /**
   * The member's roles (ADR-0026), any order: workspace bits are their OR, their room
   * overrides (`roleOverrides`, by role id) apply lowest position first.
   */
  roles?: readonly RoleBits[] | undefined;
  roleOverrides?: Readonly<Record<string, OverrideBits>> | ReadonlyMap<string, OverrideBits> | undefined;
  /**
   * Pre-ADR-0026 form, used when `roles` is not given: one built-in role with its default
   * permissions and its override (`roleOverride`).
   */
  role?: WorkspaceRole | undefined;
  /** Override for the user's (legacy) built-in role in this room. */
  roleOverride?: OverrideBits | undefined;
  /** Override for this specific user in this room (takes precedence over the role override). */
  userOverride?: OverrideBits | undefined;
  /** Set for a DM room (Room.type DM): the fixed DM set for a participant, role/overrides ignored. */
  dm?: { participant: boolean } | undefined;
  /**
   * Room.restricted (ADR-0029): ADMINISTRATOR gives no bypass — admins count as plain members
   * of the room (overrides decide), the workspace owner (`owner`) has everything.
   */
  restricted?: boolean | undefined;
  /** The user is the workspace owner (Workspace.owner_id; holder of the built-in owner role). */
  owner?: boolean | undefined;
  /**
   * Set for a task board (ADR-0042): the overrides are the board's and touch only
   * BOARD_ONLY_PERMISSIONS; a private board (Board.isPrivate) drops the roles' VIEW_BOARD
   * first; without VIEW_BOARD nothing; a guest (highest built-in role GUEST) gets nothing.
   * `restricted` / `owner` do not apply. Go: perm.ComputeBoard.
   */
  board?: { private: boolean; guest?: boolean | undefined } | undefined;
}

/** The plain OR of the roles' permissions (ADMINISTRATOR not expanded). */
function rawPermissions(roles: readonly Pick<RoleBits, 'permissions'>[]): PermissionBits {
  let perms = 0n;
  for (const r of roles) perms |= r.permissions;
  return perms;
}

/** Workspace-level permissions of a set of roles: their OR; ADMINISTRATOR means everything. */
export function workspacePermissions(roles: readonly Pick<RoleBits, 'permissions'>[]): PermissionBits {
  const perms = rawPermissions(roles);
  return perms & ADMINISTRATOR ? ALL_PERMISSIONS : perms;
}

/** Whether the roles include the built-in owner role: only the workspace owner holds it (ADR-0029). */
export function holdsOwnerRole(roles: readonly Pick<RoleBits, 'builtin'>[]): boolean {
  return roles.some((r) => r.builtin === WorkspaceRole.OWNER);
}

function overrideOf(ovs: ComputePermissionsInput['roleOverrides'], id: string): OverrideBits | undefined {
  if (!ovs) return undefined;
  if (ovs instanceof Map) return ovs.get(id);
  return Object.prototype.hasOwnProperty.call(ovs, id)
    ? (ovs as Readonly<Record<string, OverrideBits>>)[id]
    : undefined;
}

/**
 * The single function computing effective room permissions (docs/04, ADR-0026, ADR-0029):
 * workspace bits (OR of the roles; ADMINISTRATOR → everything, overrides ignored — except in a
 * restricted room, where the owner gets everything and ADMINISTRATOR is dropped), then each role's
 * room override lowest position first (deny, then allow: the most senior role wins), then the
 * user's own override; without VIEW_ROOM nothing. Overrides only touch ROOM_ONLY_PERMISSIONS.
 * Used by the client for UI; mirrored in Go (apps/server/internal/perm). Pure.
 */
export function computePermissions(input: ComputePermissionsInput): PermissionBits {
  if (input.dm) return input.dm.participant ? DM_PERMISSIONS : 0n;
  let roles: readonly RoleBits[];
  let roleOverrides = input.roleOverrides;
  if (input.roles) {
    roles = input.roles;
  } else {
    const role = input.role ?? WorkspaceRole.UNSPECIFIED;
    if (role === WorkspaceRole.UNSPECIFIED) return 0n;
    const id = ROLE_TARGET_ID[role];
    roles = [
      {
        id,
        position: BUILTIN_ROLE_POSITION[role],
        permissions: ROLE_DEFAULTS[role],
      },
    ];
    roleOverrides = input.roleOverride ? { [id]: input.roleOverride } : undefined;
  }
  let perms = rawPermissions(roles);
  if (input.board) {
    if (input.board.guest) return 0n;
    if (perms & ADMINISTRATOR) return ALL_PERMISSIONS;
    if (input.board.private) perms &= ~VIEW_BOARD;
    return applyOverrides(perms, roles, roleOverrides, input.userOverride, BOARD_ONLY_PERMISSIONS, VIEW_BOARD);
  }
  if (input.restricted) {
    if (input.owner) return ALL_PERMISSIONS;
    perms &= ~ADMINISTRATOR;
  } else if (perms & ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  return applyOverrides(perms, roles, roleOverrides, input.userOverride, ROOM_ONLY_PERMISSIONS, VIEW_ROOM);
}

/**
 * Each role's override lowest position first (deny, then allow), then the user's own, limited to
 * `mask`; without `view` nothing.
 */
function applyOverrides(
  start: PermissionBits,
  roles: readonly RoleBits[],
  roleOverrides: ComputePermissionsInput['roleOverrides'],
  userOverride: OverrideBits | undefined,
  mask: PermissionBits,
  view: PermissionBits,
): PermissionBits {
  let perms = start;
  const ordered = [...roles].sort((a, b) => a.position - b.position);
  for (const r of ordered) {
    const o = overrideOf(roleOverrides, r.id);
    if (o) {
      perms &= ~(o.deny & mask);
      perms |= o.allow & mask;
    }
  }
  if (userOverride) {
    perms &= ~(userOverride.deny & mask);
    perms |= userOverride.allow & mask;
  }
  if (!(perms & view)) return 0n;
  return perms;
}

/**
 * Effective permissions of a member with `roles` on a task board, given Board.permissionOverrides
 * and Board.isPrivate (ADR-0042). `guest`: the member's highest built-in role is GUEST.
 */
export function computeMemberBoardPermissions(
  roles: readonly RoleBits[],
  userId: string,
  overrides: readonly RoomPermissionOverride[],
  isPrivate: boolean,
  guest = false,
): PermissionBits {
  const roleOverrides = new Map<string, OverrideBits>();
  for (const o of overrides) {
    if (o.targetType === PermissionTargetType.ROLE && !roleOverrides.has(o.targetId)) roleOverrides.set(o.targetId, o);
  }
  return computePermissions({
    roles,
    roleOverrides,
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
    board: { private: isPrivate, guest },
  });
}

/**
 * Bits in a task's comment room (Go: perm.TaskRoom): VIEW_BOARD → VIEW_ROOM | SEND_MESSAGES |
 * ATTACH_FILES (read-only for an archived task), EDIT_TASKS adds MANAGE_MESSAGES.
 */
export function taskRoomPermissions(board: PermissionBits, archived = false): PermissionBits {
  if (!(board & VIEW_BOARD)) return 0n;
  let p = VIEW_ROOM;
  if (!archived) p |= SEND_MESSAGES | ATTACH_FILES;
  if (board & PERMISSION_BITS.EDIT_TASKS) p |= PERMISSION_BITS.MANAGE_MESSAGES;
  return p;
}

/** The member's roles among the workspace's (WorkspaceMember.roleIds → WorkspaceSnapshot.roles). */
export function memberRoles<R extends RoleBits>(all: readonly R[], roleIds: readonly string[]): R[] {
  const ids = new Set(roleIds);
  return all.filter((r) => ids.has(r.id));
}

/**
 * Effective permissions of a member with `roles` in a room, given Room.permissionOverrides and
 * Room.restricted (ADR-0029). The owner is recognized by the built-in owner role among `roles`
 * unless `owner` is given.
 */
export function computeMemberRoomPermissions(
  roles: readonly RoleBits[],
  userId: string,
  overrides: readonly RoomPermissionOverride[],
  restricted = false,
  owner: boolean = holdsOwnerRole(roles),
): PermissionBits {
  const roleOverrides = new Map<string, OverrideBits>();
  // First match per target, like Go perm.ComputeIn (the server never stores duplicates).
  for (const o of overrides) {
    if (o.targetType === PermissionTargetType.ROLE && !roleOverrides.has(o.targetId)) roleOverrides.set(o.targetId, o);
  }
  return computePermissions({
    roles,
    roleOverrides,
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
    restricted,
    owner,
  });
}

/**
 * Pre-ADR-0026 wire name of a built-in role as RoomPermissionOverride.target_id. The server
 * now stores and returns role ids (still accepting these names in requests).
 */
export const ROLE_TARGET_ID: Record<WorkspaceRole, string> = {
  [WorkspaceRole.UNSPECIFIED]: '',
  [WorkspaceRole.OWNER]: 'owner',
  [WorkspaceRole.ADMIN]: 'admin',
  [WorkspaceRole.MEMBER]: 'member',
  [WorkspaceRole.GUEST]: 'guest',
};

/**
 * Pre-ADR-0026: effective permissions of a user with one built-in role in a room (role
 * targets matched by name). Prefer computeMemberRoomPermissions.
 */
export function computeRoomPermissions(
  role: WorkspaceRole,
  userId: string,
  overrides: readonly RoomPermissionOverride[],
): PermissionBits {
  const roleId = ROLE_TARGET_ID[role];
  return computePermissions({
    role,
    roleOverride: overrides.find((o) => o.targetType === PermissionTargetType.ROLE && o.targetId === roleId),
    userOverride: overrides.find((o) => o.targetType === PermissionTargetType.USER && o.targetId === userId),
  });
}

export function has(perms: PermissionBits, p: PermissionBits): boolean {
  return (perms & p) === p;
}
