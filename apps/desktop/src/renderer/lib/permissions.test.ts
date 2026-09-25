import { create } from '@bufbuild/protobuf';
import { PERMISSION_BITS, PermissionTargetType, RoomPermissionOverrideSchema, RoomSchema, WorkspaceRole } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { can, compactDrafts, cycleTri, isAdminRole, roomPerms, triOf, withTri, workspacePerms } from './permissions';

const { VIEW_ROOM, SEND_MESSAGES, STREAM, MANAGE_ROOM } = PERMISSION_BITS;

function room(overrides: { t: PermissionTargetType; id: string; allow?: bigint; deny?: bigint }[]) {
  return create(RoomSchema, {
    id: 'r1',
    permissionOverrides: overrides.map((o) =>
      create(RoomPermissionOverrideSchema, { targetType: o.t, targetId: o.id, allow: o.allow ?? 0n, deny: o.deny ?? 0n }),
    ),
  });
}

describe('roomPerms', () => {
  it('member defaults allow chat, not management', () => {
    const p = roomPerms(WorkspaceRole.MEMBER, 'u1', room([]));
    expect(can(p, 'SEND_MESSAGES')).toBe(true);
    expect(can(p, 'MANAGE_ROOM')).toBe(false);
  });

  it('private room: member denied, specific user allowed', () => {
    const r = room([
      { t: PermissionTargetType.ROLE, id: 'member', deny: VIEW_ROOM },
      { t: PermissionTargetType.USER, id: 'u2', allow: VIEW_ROOM },
    ]);
    expect(roomPerms(WorkspaceRole.MEMBER, 'u1', r)).toBe(0n);
    expect(can(roomPerms(WorkspaceRole.MEMBER, 'u2', r), 'VIEW_ROOM')).toBe(true);
  });

  it('admin ignores deny', () => {
    const r = room([{ t: PermissionTargetType.ROLE, id: 'admin', deny: VIEW_ROOM | STREAM }]);
    expect(can(roomPerms(WorkspaceRole.ADMIN, 'a', r), 'STREAM')).toBe(true);
  });

  it('guest sees nothing without explicit allow', () => {
    expect(roomPerms(WorkspaceRole.GUEST, 'g', room([]))).toBe(0n);
    const r = room([{ t: PermissionTargetType.ROLE, id: 'guest', allow: VIEW_ROOM | SEND_MESSAGES }]);
    expect(can(roomPerms(WorkspaceRole.GUEST, 'g', r), 'SEND_MESSAGES')).toBe(true);
  });

  it('unknown room / role → no permissions', () => {
    expect(roomPerms(undefined, 'u', room([]))).toBe(0n);
    expect(roomPerms(WorkspaceRole.MEMBER, 'u', undefined)).toBe(0n);
  });
});

describe('workspace level', () => {
  it('admins get everything', () => {
    expect(can(workspacePerms(WorkspaceRole.OWNER), 'MANAGE_WORKSPACE')).toBe(true);
    expect(can(workspacePerms(WorkspaceRole.MEMBER), 'MANAGE_WORKSPACE')).toBe(false);
    expect(isAdminRole(WorkspaceRole.ADMIN)).toBe(true);
    expect(isAdminRole(WorkspaceRole.MEMBER)).toBe(false);
  });
});

describe('tri-state editor', () => {
  it('cycles inherit → allow → deny → inherit and keeps bits exclusive', () => {
    let o = { allow: 0n, deny: 0n };
    expect(triOf(o, MANAGE_ROOM)).toBe('inherit');
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(triOf(o, MANAGE_ROOM)).toBe('allow');
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(triOf(o, MANAGE_ROOM)).toBe('deny');
    expect(o.allow & MANAGE_ROOM).toBe(0n);
    o = withTri(o, MANAGE_ROOM, cycleTri(triOf(o, MANAGE_ROOM)));
    expect(o).toEqual({ allow: 0n, deny: 0n });
  });

  it('compact drops empty overrides', () => {
    const drafts = [
      { targetType: PermissionTargetType.ROLE, targetId: 'member', allow: 0n, deny: 0n },
      { targetType: PermissionTargetType.USER, targetId: 'u', allow: VIEW_ROOM, deny: 0n },
    ];
    expect(compactDrafts(drafts)).toHaveLength(1);
  });
});
