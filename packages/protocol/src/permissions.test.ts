import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, RoomPermissionOverrideSchema } from './gen/calaba/v1/room_pb.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_BITS,
  ROLE_DEFAULTS,
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
  rs.map((r) => ({ id: r.id, position: r.position, permissions: BigInt(r.permissions) }));

describe('computePermissions (shared vectors)', () => {
  for (const v of vectors) {
    it(v.name, () => {
      if (v.roles) {
        const roles = toRoles(v.roles);
        const roleOverrides = Object.fromEntries(
          Object.entries(v.roleOverrides ?? {}).map(([id, o]) => [id, toOv(o) as OverrideBits]),
        );
        expect(computePermissions({ roles, roleOverrides, userOverride: toOv(v.userOverride) })).toBe(BigInt(v.expected));
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
        expect(computeMemberRoomPermissions(roles, 'u1', overrides)).toBe(BigInt(v.expected));
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
      { id: 'm', position: 1, permissions: ROLE_DEFAULTS[WorkspaceRole.MEMBER] },
    ];
    expect(memberRoles(all, ['m']).map((r) => r.id)).toEqual(['m']);
    expect(workspacePermissions(memberRoles(all, ['m', 'a']))).toBe(ALL_PERMISSIONS);
    expect(ALL_PERMISSIONS & PERMISSION_BITS.MANAGE_ROLES).toBe(PERMISSION_BITS.MANAGE_ROLES);
    expect(ALL_PERMISSIONS).toBe(65535n);
  });
});
