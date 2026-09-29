import { create } from '@bufbuild/protobuf';
import {
  BadgeSchema,
  PERMISSION_BITS,
  PresenceSchema,
  RoleSchema,
  RoomSchema,
  UserSchema,
  VoiceStateSchema,
  WorkspaceBackgroundSchema,
  WorkspaceMemberSchema,
  WorkspaceRole,
  WorkspaceSchema,
  WorkspaceSnapshotSchema,
} from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { legacyRoles } from '../lib/roles';
import { mayArrangeRooms, mayManageWorkspace, roomPerms, voiceCaps } from '../lib/permissions';
import { findBackground, memberBadge, rolesOf, useWorkspaces } from './workspaces';

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

  it('live, without a reconnect: a role edit or a custom role grant changes my rights at once', () => {
    const st = useWorkspaces.getState();
    const r = create(RoomSchema, { id: 'v', workspaceId: W, media: { cameraLimit: 2 } });
    st.applySnapshot(snapshot(member('me', WorkspaceRole.MEMBER, ['member'])));
    const caps = () => voiceCaps(roomPerms(rolesOf(useWorkspaces.getState().byId[W], 'me'), 'me', r), r);
    expect(caps()).toEqual({ canStream: true, canVideo: true });
    // ROLE_UPDATE of «member» without STREAM (voice.refreshRights reads the store).
    const memberRole = legacyRoles(W).find((x) => x.id === 'member');
    if (!memberRole) throw new Error('no member role');
    st.upsertRole({ ...memberRole, permissions: memberRole.permissions & ~PERMISSION_BITS.STREAM });
    expect(caps()).toEqual({ canStream: false, canVideo: true });
    // A custom role with MANAGE_WORKSPACE given while online: the settings / invites appear.
    expect(mayManageWorkspace(rolesOf(useWorkspaces.getState().byId[W], 'me'))).toBe(false);
    st.upsertRole(create(RoleSchema, { id: 'r-ws', workspaceId: W, name: 'Managers', position: 3, permissions: PERMISSION_BITS.MANAGE_WORKSPACE }));
    st.upsertMember(member('me', WorkspaceRole.MEMBER, ['member', 'r-ws']));
    expect(mayManageWorkspace(rolesOf(useWorkspaces.getState().byId[W], 'me'))).toBe(true);
  });

  it('ROOM_DELETE (deleted or hidden): the room\'s participants are no longer in voice', () => {
    const st = useWorkspaces.getState();
    st.applySnapshot(snapshot(member('me', WorkspaceRole.MEMBER, ['member'])));
    st.setVoiceState(create(VoiceStateSchema, { workspaceId: W, userId: 'a', roomId: 'r1' }));
    st.setVoiceState(create(VoiceStateSchema, { workspaceId: W, userId: 'b', roomId: 'r2' }));
    st.clearRoomVoice(W, 'r1');
    expect(Object.keys(useWorkspaces.getState().byId[W]?.voice ?? {})).toEqual(['b']);
    const before = useWorkspaces.getState().byId[W];
    st.clearRoomVoice(W, 'nothing-here');
    expect(useWorkspaces.getState().byId[W]).toBe(before);
  });
});

describe('custom status (owner, 27.09: it showed everywhere only after a reload)', () => {
  it('PRESENCE_UPDATE with a custom status updates the user card at once, and clearing it too', () => {
    const me = member('u1', WorkspaceRole.MEMBER);
    useWorkspaces.getState().applySnapshot(snapshot(me));
    const st = useWorkspaces.getState();
    st.setPresence(create(PresenceSchema, { userId: 'u1', statusText: 'В отпуске', statusEmoji: '🏖️' }));
    expect(useWorkspaces.getState().users['u1']).toMatchObject({ statusText: 'В отпуске', statusEmoji: '🏖️' });
    expect(useWorkspaces.getState().byId[W]?.members['u1']?.user).toMatchObject({ statusText: 'В отпуске' });
    // The sweeper's PRESENCE_UPDATE for an expired status (issue #17): empty everywhere.
    st.setPresence(create(PresenceSchema, { userId: 'u1', statusText: '', statusEmoji: '' }));
    expect(useWorkspaces.getState().users['u1']).toMatchObject({ statusText: '', statusEmoji: '', statusExpiresAt: undefined });
    expect(useWorkspaces.getState().byId[W]?.members['u1']?.user).toMatchObject({ statusText: '', statusEmoji: '' });
    // Unknown users only get a presence entry; an unchanged status keeps the same user object.
    const before = useWorkspaces.getState().users['u1'];
    st.setPresence(create(PresenceSchema, { userId: 'u1' }));
    expect(useWorkspaces.getState().users['u1']).toBe(before);
    st.setPresence(create(PresenceSchema, { userId: 'nobody', statusText: 'x' }));
    expect(useWorkspaces.getState().users['nobody']).toBeUndefined();
  });
});

describe('member badges in the store (docs/09 #82)', () => {
  const acme = create(BadgeSchema, { id: 'b1', workspaceId: W, name: 'Acme', fileId: 'f1' });
  const withBadge = (id: string, badgeId: string) => Object.assign(member(id, WorkspaceRole.MEMBER), { badgeId });

  it('READY carries the library; the selector gives the member its badge object', () => {
    const snap = snapshot(withBadge('me', 'b1'));
    snap.badges = [acme];
    snap.members.push(member('bob', WorkspaceRole.MEMBER));
    useWorkspaces.getState().applySnapshot(snap);
    const e = useWorkspaces.getState().byId[W];
    expect(memberBadge(e, 'me')).toBe(e?.badges.b1);
    expect(memberBadge(e, 'bob')).toBeUndefined();
    expect(memberBadge(undefined, 'me')).toBeUndefined();
  });

  it('the selector result stays the same object when other members or badges change', () => {
    const snap = snapshot(withBadge('me', 'b1'));
    snap.badges = [acme];
    useWorkspaces.getState().applySnapshot(snap);
    const before = memberBadge(useWorkspaces.getState().byId[W], 'me');
    useWorkspaces.getState().upsertMember(member('bob', WorkspaceRole.MEMBER));
    useWorkspaces.getState().upsertBadge(create(BadgeSchema, { id: 'b2', workspaceId: W, name: 'Other', fileId: 'f2' }));
    expect(memberBadge(useWorkspaces.getState().byId[W], 'me')).toBe(before);
    // Renamed: a new object, the same id.
    useWorkspaces.getState().upsertBadge(create(BadgeSchema, { id: 'b1', workspaceId: W, name: 'Acme Corp', fileId: 'f1' }));
    expect(memberBadge(useWorkspaces.getState().byId[W], 'me')?.name).toBe('Acme Corp');
    expect(Object.keys(useWorkspaces.getState().byId[W]?.badges ?? {})).toEqual(['b1', 'b2']);
  });

  it('BADGE_DELETE drops the badge and clears it from members still showing it', () => {
    const snap = snapshot(withBadge('me', 'b1'));
    snap.badges = [acme];
    useWorkspaces.getState().applySnapshot(snap);
    useWorkspaces.getState().removeBadge(W, 'b1');
    const e = useWorkspaces.getState().byId[W];
    expect(e?.badges).toEqual({});
    expect(e?.members.me?.badgeId).toBe('');
    expect(memberBadge(e, 'me')).toBeUndefined();
  });
});

describe('workspace camera backgrounds in the store (ADR-0035 addendum)', () => {
  const office = create(WorkspaceBackgroundSchema, { id: 'bg1', workspaceId: W, name: 'Office', fileId: 'f1' });

  it('READY carries them; create / rename / delete follow the events', () => {
    const snap = snapshot(member('me', WorkspaceRole.MEMBER));
    snap.backgrounds = [office];
    useWorkspaces.getState().applySnapshot(snap);
    expect(findBackground('bg1')?.fileId).toBe('f1');
    useWorkspaces.getState().upsertBackground(create(WorkspaceBackgroundSchema, { id: 'bg2', workspaceId: W, name: 'Logo', fileId: 'f2' }));
    useWorkspaces.getState().upsertBackground(create(WorkspaceBackgroundSchema, { id: 'bg1', workspaceId: W, name: 'Open space', fileId: 'f1' }));
    const e = useWorkspaces.getState().byId[W];
    expect(Object.values(e?.backgrounds ?? {}).map((b) => b.name)).toEqual(['Open space', 'Logo']);
    useWorkspaces.getState().removeBackground(W, 'bg1');
    expect(findBackground('bg1')).toBeUndefined();
    expect(findBackground('bg2')?.name).toBe('Logo');
  });

  it('a background of an unknown workspace is ignored; a left workspace takes its backgrounds', () => {
    useWorkspaces.getState().upsertBackground(create(WorkspaceBackgroundSchema, { id: 'bgX', workspaceId: 'nope', name: 'X', fileId: 'fX' }));
    expect(findBackground('bgX')).toBeUndefined();
    const snap = snapshot(member('me', WorkspaceRole.MEMBER));
    snap.backgrounds = [office];
    useWorkspaces.getState().applySnapshot(snap);
    useWorkspaces.getState().remove(W);
    expect(findBackground('bg1')).toBeUndefined();
  });
});
