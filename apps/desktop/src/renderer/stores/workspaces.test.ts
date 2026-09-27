import { create } from '@bufbuild/protobuf';
import { PERMISSION_BITS, RoleSchema, UserSchema, WorkspaceMemberSchema, WorkspaceRole, WorkspaceSchema, WorkspaceSnapshotSchema } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { legacyRoles } from '../lib/roles';
import { mayArrangeRooms } from '../lib/permissions';
import { rolesOf, useWorkspaces } from './workspaces';

const W = 'w1';
const member = (id: string, role: WorkspaceRole, roleIds: string[] = []) =>
  create(WorkspaceMemberSchema, { workspaceId: W, role, roleIds, user: create(UserSchema, { id, displayName: id }) });
const custom = create(RoleSchema, { id: 'r-dj', workspaceId: W, name: 'DJ', position: 2, permissions: PERMISSION_BITS.MANAGE_ROOM, color: 0xff9f0a });

function snapshot(me: ReturnType<typeof member>, roles = [...legacyRoles(W), custom]) {
  return create(WorkspaceSnapshotSchema, { workspace: create(WorkspaceSchema, { id: W, name: 'W' }), role: me.role, members: [me], roles });
}

beforeEach(() => useWorkspaces.getState().reset());

describe('workspace roles in the store (ADR-0026)', () => {
  it('a member promoted to admin while online may drag rooms at once (MEMBER_UPDATE, no reconnect)', () => {
    const st = useWorkspaces.getState();
    st.applySnapshot(snapshot(member('me', WorkspaceRole.MEMBER, ['member'])));
    expect(mayArrangeRooms(rolesOf(useWorkspaces.getState().byId[W], 'me'))).toBe(false);
    st.upsertMember(member('me', WorkspaceRole.ADMIN, ['admin', 'member']));
    st.setMyRole(W, WorkspaceRole.ADMIN);
    const e = useWorkspaces.getState().byId[W];
    expect(e?.role).toBe(WorkspaceRole.ADMIN);
    expect(mayArrangeRooms(rolesOf(e, 'me'))).toBe(true);
  });

  it('an older server (no roles, no role_ids): the built-ins stand in, the admin still arranges rooms', () => {
    useWorkspaces.getState().applySnapshot(snapshot(member('me', WorkspaceRole.ADMIN), []));
    const e = useWorkspaces.getState().byId[W];
    expect(e?.roles.map((r) => r.id)).toEqual(['owner', 'admin', 'member', 'guest']);
    expect(rolesOf(e, 'me').map((r) => r.id)).toEqual(['admin', 'member']);
    expect(mayArrangeRooms(rolesOf(e, 'me'))).toBe(true);
  });

  it('ROLE_CREATE / UPDATE keep the order; ROLE_DELETE drops the role from every member', () => {
    const st = useWorkspaces.getState();
    st.applySnapshot(snapshot(member('me', WorkspaceRole.MEMBER, ['member', 'r-dj'])));
    expect(mayArrangeRooms(rolesOf(useWorkspaces.getState().byId[W], 'me'))).toBe(true);
    st.upsertRole(create(RoleSchema, { id: 'r-new', workspaceId: W, name: 'New', position: 3 }));
    expect(useWorkspaces.getState().byId[W]?.roles.map((r) => r.id)).toEqual(['owner', 'admin', 'r-new', 'r-dj', 'member', 'guest']);
    st.removeRole(W, 'r-dj');
    const e = useWorkspaces.getState().byId[W];
    expect(e?.members['me']?.roleIds).toEqual(['member']);
    expect(mayArrangeRooms(rolesOf(e, 'me'))).toBe(false);
  });
});
