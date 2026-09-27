import { create } from '@bufbuild/protobuf';
import {
  PERMISSION_BITS,
  PermissionTargetType,
  PresenceSchema,
  PresenceStatus,
  RoleSchema,
  RoomPermissionOverrideSchema,
  RoomSchema,
  RoomType,
  UserSchema,
  VoiceStateSchema,
  WorkspaceMemberSchema,
  WorkspaceRole,
  type Room,
  type WorkspaceMember,
} from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { legacyRoles } from '../../lib/roles';
import { groupMembers, hasAnyAction, memberActions, type MenuContext } from './members';

const member = (id: string, name: string, role: WorkspaceRole, nickname = '', isGuest = false): WorkspaceMember =>
  create(WorkspaceMemberSchema, { workspaceId: 'w', role, nickname, user: create(UserSchema, { id, displayName: name, isGuest }) });

const room = (id: string, type = RoomType.VOICE, overrides: Room['permissionOverrides'] = []): Room =>
  create(RoomSchema, { id, workspaceId: 'w', type, name: id, permissionOverrides: overrides });

const voice = (userId: string, roomId: string, muted = false) => create(VoiceStateSchema, { workspaceId: 'w', userId, roomId, muted });

describe('groupMembers', () => {
  const owner = member('o', 'Яна', WorkspaceRole.OWNER);
  const admin = member('a', 'Борис', WorkspaceRole.ADMIN);
  const m1 = member('m1', 'Вера', WorkspaceRole.MEMBER);
  const m2 = member('m2', 'Зоя', WorkspaceRole.MEMBER, 'Аня');
  const guest = member('g', 'Анатолий', WorkspaceRole.GUEST, '', true);
  const p = (userId: string, status: PresenceStatus) => create(PresenceSchema, { userId, status });

  it('splits online / offline and sorts by role, then (nick)name', () => {
    const g = groupMembers([guest, m1, m2, admin, owner], {
      o: p('o', PresenceStatus.ONLINE),
      m1: p('m1', PresenceStatus.IDLE),
      m2: p('m2', PresenceStatus.DND),
      g: p('g', PresenceStatus.ONLINE),
      a: p('a', PresenceStatus.OFFLINE),
    });
    expect(g.online.map((m) => m.user?.id)).toEqual(['o', 'm2', 'm1', 'g']);
    expect(g.offline.map((m) => m.user?.id)).toEqual(['a']);
  });

  it('counts people in voice as online and skips members without a user', () => {
    const g = groupMembers([m1, create(WorkspaceMemberSchema, { role: WorkspaceRole.MEMBER })], {}, { m1: voice('m1', 'r1') });
    expect(g.online).toHaveLength(1);
    expect(g.offline).toHaveLength(0);
  });
});

describe('memberActions', () => {
  const call = room('call');
  const meeting = room('meeting');
  const text = room('general', RoomType.TEXT);
  const base = (over: Partial<MenuContext>): MenuContext => ({
    meId: 'me',
    myRole: WorkspaceRole.ADMIN,
    target: member('t', 'Target', WorkspaceRole.MEMBER),
    targetVoice: undefined,
    myVoiceRoomId: null,
    rooms: [call, meeting, text],
    allowSelfNickname: true,
    ...over,
  });

  it('admin on a member in voice: everything, move targets = other voice rooms', () => {
    const a = memberActions(base({ targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ volume: true, serverMute: true, disconnect: true, rename: true, kick: true, promote: false, removeGuest: false });
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
  });

  it('server mute: a moderator can lift it; the user\'s own mute is not a moderator mute', () => {
    const muted = { ...voice('t', 'call'), serverMuted: true };
    const a = memberActions(base({ targetVoice: muted, myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ alreadyMuted: true, serverUnmute: true });
    const self = memberActions(base({ targetVoice: { ...voice('t', 'call'), muted: true }, myVoiceRoomId: 'call' }));
    expect(self).toMatchObject({ alreadyMuted: false, serverUnmute: false, serverMute: true });
    const member = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: muted, myVoiceRoomId: 'call' }));
    expect(member.serverUnmute).toBe(false);
  });

  it('member: only volume in the same room; nothing when not in voice', () => {
    const a = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }));
    expect(a).toMatchObject({ volume: true, serverMute: false, disconnect: false, rename: false, kick: false });
    expect(a.moveTargets).toEqual([]);
    expect(hasAnyAction(memberActions(base({ myRole: WorkspaceRole.MEMBER })))).toBe(false);
  });

  it('camera: «Не показывать видео» for a camera in my room; «Выключить камеру» for a moderator', () => {
    const cam = { ...voice('t', 'call'), camera: true };
    expect(memberActions(base({ targetVoice: cam, myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: true, stopCamera: true });
    const plain = memberActions(base({ myRole: WorkspaceRole.MEMBER, targetVoice: cam, myVoiceRoomId: 'call' }));
    expect(plain).toMatchObject({ hideVideo: true, stopCamera: false });
    // Another room: nothing to hide (not subscribed anyway); the moderator can still stop it.
    expect(memberActions(base({ targetVoice: cam, myVoiceRoomId: 'meeting' }))).toMatchObject({ hideVideo: false, stopCamera: true });
    expect(memberActions(base({ targetVoice: voice('t', 'call'), myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: false, stopCamera: false });
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.MEMBER), targetVoice: { ...cam, userId: 'me' }, myVoiceRoomId: 'call' }))).toMatchObject({ hideVideo: false, stopCamera: false });
  });

  it('roles (ADR-0026): checkboxes for the roles I may give; only the owner grants / revokes admin', () => {
    const design = create(RoleSchema, { id: 'r-design', name: 'Design', position: 3, permissions: PERMISSION_BITS.STREAM });
    const mod = create(RoleSchema, { id: 'r-mod', name: 'Moderator', position: 2, permissions: PERMISSION_BITS.MUTE_MEMBERS | PERMISSION_BITS.MANAGE_ROLES });
    const roles = [...legacyRoles('w'), design, mod];
    const ids = (a: ReturnType<typeof memberActions>): Array<[string, boolean, boolean]> | null =>
      a.roles?.map((x) => [x.role.id, x.on, x.enabled]) ?? null;
    // Admin: custom roles yes, admin no (only the owner) — the admin row is left out as the target lacks it.
    expect(ids(memberActions(base({ roles })))).toEqual([
      ['r-design', false, true],
      ['r-mod', false, true],
    ]);
    // Owner: admin too; a held role shows checked.
    const withDesign = create(WorkspaceMemberSchema, { ...member('t', 'T', WorkspaceRole.MEMBER), roleIds: ['member', 'r-design'] });
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: withDesign })))).toEqual([
      ['admin', false, true],
      ['r-design', true, true],
      ['r-mod', false, true],
    ]);
    // An admin target: an admin may not touch them (not below), the owner may.
    expect(memberActions(base({ roles, target: member('t', 'A', WorkspaceRole.ADMIN) })).roles).toBeNull();
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: member('t', 'A', WorkspaceRole.ADMIN) })))?.[0]).toEqual(['admin', true, true]);
    // A plain member: no MANAGE_ROLES → nothing; with Moderator (MANAGE_ROLES, position 2): only roles below 2 — none.
    expect(memberActions(base({ roles, myRole: WorkspaceRole.MEMBER })).roles).toBeNull();
    expect(memberActions(base({ roles, myRole: WorkspaceRole.MEMBER, myRoleIds: ['member', 'r-mod'] })).roles).toBeNull();
    // A guest can get custom roles, but not admin.
    expect(ids(memberActions(base({ roles, myRole: WorkspaceRole.OWNER, target: member('t', 'G', WorkspaceRole.GUEST, '', true) })))?.map((x) => x[0])).toEqual(['r-design', 'r-mod']);
    // Legacy server (only built-ins): an admin has nothing to give, the owner gives admin.
    expect(memberActions(base({})).roles).toBeNull();
    expect(ids(memberActions(base({ myRole: WorkspaceRole.OWNER })))).toEqual([['admin', false, true]]);
  });

  it('volume only for someone in my voice room; «Заглушить» for anyone but me', () => {
    expect(memberActions(base({ targetVoice: voice('t', 'meeting'), myVoiceRoomId: 'call' })).volume).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER })).localMute).toBe(true);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.MEMBER) })).localMute).toBe(false);
  });

  it('own nickname follows allow_self_nickname; admins always', () => {
    const me = member('me', 'Me', WorkspaceRole.MEMBER);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: me })).rename).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: me, allowSelfNickname: false })).rename).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN), allowSelfNickname: false })).rename).toBe(true);
  });

  it('guests: promote / remove instead of kick', () => {
    const a = memberActions(base({ target: member('t', 'G', WorkspaceRole.GUEST, '', true) }));
    expect(a).toMatchObject({ promote: true, removeGuest: true, kick: false });
  });

  it('only the owner removes admins; nobody removes the owner or themselves', () => {
    const adminT = member('t', 'A', WorkspaceRole.ADMIN);
    expect(memberActions(base({ target: adminT })).kick).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: adminT })).kick).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: member('t', 'O', WorkspaceRole.OWNER) })).kick).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN) })).kick).toBe(false);
  });

  it('ban (docs/09 #32): the same rule as kick, guests included', () => {
    const adminT = member('t', 'A', WorkspaceRole.ADMIN);
    expect(memberActions(base({ target: member('t', 'M', WorkspaceRole.MEMBER) })).ban).toBe(true);
    expect(memberActions(base({ target: member('t', 'G', WorkspaceRole.GUEST, '', true) })).ban).toBe(true);
    expect(memberActions(base({ target: adminT })).ban).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: adminT })).ban).toBe(true);
    expect(memberActions(base({ myRole: WorkspaceRole.OWNER, target: member('t', 'O', WorkspaceRole.OWNER) })).ban).toBe(false);
    expect(memberActions(base({ target: member('me', 'Me', WorkspaceRole.ADMIN) })).ban).toBe(false);
    expect(memberActions(base({ myRole: WorkspaceRole.MEMBER, target: member('t', 'M', WorkspaceRole.MEMBER) })).ban).toBe(false);
  });

  it('room overrides: MOVE_MEMBERS granted per room limits the submenu to those rooms', () => {
    const grant = [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 'me', allow: PERMISSION_BITS.MOVE_MEMBERS, deny: 0n }),
    ];
    const a = memberActions(
      base({ myRole: WorkspaceRole.MEMBER, rooms: [room('call', RoomType.VOICE, grant), room('meeting', RoomType.VOICE, grant), room('locked')], targetVoice: voice('t', 'call') }),
    );
    expect(a.moveTargets.map((r) => r.id)).toEqual(['meeting']);
    expect(a.serverMute).toBe(false);
  });

  it('room MUTE_MEMBERS grant: disconnect only; server mute/unmute need it workspace-wide', () => {
    const grant = [
      create(RoomPermissionOverrideSchema, { targetType: PermissionTargetType.USER, targetId: 'me', allow: PERMISSION_BITS.MUTE_MEMBERS, deny: 0n }),
    ];
    const a = memberActions(base({ myRole: WorkspaceRole.MEMBER, rooms: [room('call', RoomType.VOICE, grant)], targetVoice: { ...voice('t', 'call'), serverMuted: true } }));
    expect(a.disconnect).toBe(true);
    expect(a.serverMute).toBe(false);
    expect(a.serverUnmute).toBe(false);
  });
});
