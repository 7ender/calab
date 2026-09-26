import { readFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';
import { WorkspaceRole } from './gen/calaba/v1/permissions_pb.js';
import { PermissionTargetType, RoomPermissionOverrideSchema } from './gen/calaba/v1/room_pb.js';
import {
  ALL_PERMISSIONS,
  PERMISSION_BITS,
  ROLE_DEFAULTS,
  computePermissions,
  computeRoomPermissions,
  type OverrideBits,
} from './permissions.js';

interface Vector {
  name: string;
  role?: 'owner' | 'admin' | 'member' | 'guest';
  roomType?: 'dm';
  participant?: boolean;
  roleOverride?: { allow: number; deny: number };
  userOverride?: { allow: number; deny: number };
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

describe('computePermissions (shared vectors)', () => {
  for (const v of vectors) {
    it(v.name, () => {
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
