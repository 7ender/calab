import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, RoomPermissionOverrideSchema } from './gen/calaba/v1/room_pb.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_BITS,
  ROLE_DEFAULTS,
  ROOM_ONLY_PERMISSIONS,
  BOARD_ONLY_PERMISSIONS,
  taskRoomPermissions,
  computeMemberBoardPermissions,
  computeMemberRoomPermissions,
  computePermissions,
  computeRoomPermissions,
  memberRoles,
  workspacePermissions,
  type OverrideBits,
} from './permissions.js';

interface Vector {
  name: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
  roomType?: 'dm';
  participant?: boolean;
  roleOverride?: { allow: number; deny: number };
  userOverride?: { allow: number; deny: number };
  // ADR-0026: the member's roles and the room's overrides by role id.
  roles?: { id: string; position: number; permissions: number }[];
  roleOverrides?: Record<string, { allow: number; deny: number }>;
  expectedWorkspace?: number;
  // ADR-0029: a restricted room and whether the member is the workspace owner.
  restricted?: boolean;
  owner?: boolean;
  // ADR-0042: a board vector.
  board?: { private: boolean; guest?: boolean };
  expected: number;
}

const roles = {
  owner: WorkspaceRole.OWNER,
  admin: WorkspaceRole.ADMIN,
  member: WorkspaceRole.MEMBER,
  guest: WorkspaceRole.GUEST,
} as const;

const toOv = (o?: { allow: number; deny: number }): OverrideBits | undefined =>
  o ? { allow: BigInt(o.allow), deny: BigInt(o.deny) } : undefined;

// Shared with Go (apps/server/internal/perm). Keep both implementations in sync.
const vectors = JSON.parse(
  readFileSync(new URL('../../../proto/testdata/permissions.json', import.meta.url), 'utf8'),
) as Vector[];

const toRoles = (rs: NonNullable<Vector['roles']>) =>
  rs.map((r) => ({
    id: r.id,
    position: r.position,
    permissions: BigInt(r.permissions),
  }));

describe('computePermissions (shared vectors)', () => {
  for (const v of vectors) {
    it(v.name, () => {
      if (v.board) {
        const roles = toRoles(v.roles ?? []);
        const roleOverrides = Object.fromEntries(
          Object.entries(v.roleOverrides ?? {}).map(([id, o]) => [id, toOv(o) as OverrideBits]),
        );
        expect(
          computePermissions({
            roles,
            roleOverrides,
            userOverride: toOv(v.userOverride),
            board: v.board,
          }),
        ).toBe(BigInt(v.expected));
        const overrides = [
          ...Object.entries(v.roleOverrides ?? {}).map(([id, o]) =>
            create(RoomPermissionOverrideSchema, {
              targetType: PermissionTargetType.ROLE,
              targetId: id,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny),
            }),
          ),
          ...(v.userOverride
            ? [
                create(RoomPermissionOverrideSchema, {
                  targetType: PermissionTargetType.USER,
                  targetId: 'u1',
                  allow: BigInt(v.userOverride.allow),
                  deny: BigInt(v.userOverride.deny),
                }),
              ]
            : []),
        ];
        expect(computeMemberBoardPermissions(roles, 'u1', overrides, v.board.private, v.board.guest ?? false)).toBe(
          BigInt(v.expected),
        );
        return;
      }
      if (v.roles) {
        const roles = toRoles(v.roles);
        const roleOverrides = Object.fromEntries(
          Object.entries(v.roleOverrides ?? {}).map(([id, o]) => [id, toOv(o) as OverrideBits]),
        );
        expect(
          computePermissions({
            roles,
            roleOverrides,
            userOverride: toOv(v.userOverride),
            restricted: v.restricted,
            owner: v.owner,
          }),
        ).toBe(BigInt(v.expected));
        // The same through Room.permissionOverrides.
        const overrides = [
          ...Object.entries(v.roleOverrides ?? {}).map(([id, o]) =>
            create(RoomPermissionOverrideSchema, {
              targetType: PermissionTargetType.ROLE,
              targetId: id,
              allow: BigInt(o.allow),
              deny: BigInt(o.deny),
            }),
          ),
          ...(v.userOverride
            ? [
                create(RoomPermissionOverrideSchema, {
                  targetType: PermissionTargetType.USER,
                  targetId: 'u1',
                  allow: BigInt(v.userOverride.allow),
                  deny: BigInt(v.userOverride.deny),
                }),
              ]
            : []),
        ];
        expect(computeMemberRoomPermissions(roles, 'u1', overrides, v.restricted, v.owner ?? false)).toBe(
          BigInt(v.expected),
        );
        // The owner is recognized by the built-in owner role as well.
        const withBuiltin = roles.map((r) =>
          r.id === 'owner' && v.owner ? { ...r, builtin: WorkspaceRole.OWNER } : r,
        );
        expect(computeMemberRoomPermissions(withBuiltin, 'u1', overrides, v.restricted)).toBe(BigInt(v.expected));
        if (v.expectedWorkspace !== undefined) expect(workspacePermissions(roles)).toBe(BigInt(v.expectedWorkspace));
        return;
      }
      expect(
        computePermissions({
          role: v.role ? roles[v.role] : WorkspaceRole.UNSPECIFIED,
          roleOverride: toOv(v.roleOverride),
          userOverride: toOv(v.userOverride),
          dm: v.roomType === 'dm' ? { participant: v.participant ?? false } : undefined,
        }),
      ).toBe(BigInt(v.expected));
    });
  }
});

describe('computeRoomPermissions', () => {
  it('picks the matching role and user overrides', () => {
    const overrides = [
      create(RoomPermissionOverrideSchema, {
        targetType: PermissionTargetType.ROLE,
        targetId: 'member',
        deny: PERMISSION_BITS.VIEW_ROOM,
      }),
      create(RoomPermissionOverrideSchema, {
        targetType: PermissionTargetType.USER,
        targetId: 'u1',
        allow: PERMISSION_BITS.VIEW_ROOM,
      }),
    ];
    expect(computeRoomPermissions(WorkspaceRole.MEMBER, 'u2', overrides)).toBe(0n);
    expect(computeRoomPermissions(WorkspaceRole.MEMBER, 'u1', overrides)).toBe(ROLE_DEFAULTS[WorkspaceRole.MEMBER]);
    expect(computeRoomPermissions(WorkspaceRole.ADMIN, 'u3', overrides)).toBe(ALL_PERMISSIONS);
  });
});

describe('roles (ADR-0026)', () => {
  it('memberRoles picks the member roles; MANAGE_ROLES is part of ALL_PERMISSIONS', () => {
    const all = [
      { id: 'a', position: 1000, permissions: PERMISSION_BITS.ADMINISTRATOR },
      {
        id: 'm',
        position: 1,
        permissions: ROLE_DEFAULTS[WorkspaceRole.MEMBER],
      },
    ];
    expect(memberRoles(all, ['m']).map((r) => r.id)).toEqual(['m']);
    expect(workspacePermissions(memberRoles(all, ['m', 'a']))).toBe(ALL_PERMISSIONS);
    expect(ALL_PERMISSIONS & PERMISSION_BITS.MANAGE_ROLES).toBe(PERMISSION_BITS.MANAGE_ROLES);
    expect(ALL_PERMISSIONS).toBe(8388607n);
    const invite = PERMISSION_BITS.INVITE_MEMBERS | PERMISSION_BITS.INVITE_GUESTS;
    expect(invite).toBe(6291456n);
    expect(ROOM_ONLY_PERMISSIONS & invite).toBe(invite); // ADR-0043: settable per room
    expect(ROOM_ONLY_PERMISSIONS & PERMISSION_BITS.MANAGE_STICKERS).toBe(0n);
    expect(ROOM_ONLY_PERMISSIONS & BOARD_ONLY_PERMISSIONS).toBe(0n);
  });
  it('task rooms follow the board (ADR-0042)', () => {
    const { VIEW_BOARD, EDIT_TASKS, VIEW_ROOM, SEND_MESSAGES, ATTACH_FILES, MANAGE_MESSAGES } = PERMISSION_BITS;
    expect(taskRoomPermissions(0n)).toBe(0n);
    expect(taskRoomPermissions(VIEW_BOARD)).toBe(VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES);
    expect(taskRoomPermissions(VIEW_BOARD | EDIT_TASKS)).toBe(
      VIEW_ROOM | SEND_MESSAGES | ATTACH_FILES | MANAGE_MESSAGES,
    );
    expect(taskRoomPermissions(VIEW_BOARD, true)).toBe(VIEW_ROOM);
  });
});
