import { create } from '@bufbuild/protobuf';
import { UserSchema, WorkspaceMemberSchema, WorkspaceRole, type WorkspaceMember } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { filterItems } from '../../components/picker/pickerModel';
import { memberItems, userItems } from './memberPickItems';

const m = (id: string, name: string, role: WorkspaceRole, nickname = ''): WorkspaceMember =>
  create(WorkspaceMemberSchema, { workspaceId: 'w', role, nickname, user: create(UserSchema, { id, displayName: name }) });

// The mock fixture's main workspace (e2e-support/fixtures.ts): owner, admin, two members, a guest.
const team = [
  m('dina', 'Дина', WorkspaceRole.GUEST),
  m('vera', 'Вера', WorkspaceRole.MEMBER),
  m('boris', 'Борис', WorkspaceRole.ADMIN),
  m('grigory', 'Григорий', WorkspaceRole.MEMBER, 'Гриша'),
  m('anna', 'Анна', WorkspaceRole.OWNER),
];

describe('memberItems', () => {
  it('lists every member — owner and admins too (docs/09 #33) — owner → admins → members → guests', () => {
    expect(memberItems(team).map((i) => i.userId)).toEqual(['anna', 'boris', 'vera', 'grigory', 'dina']);
  });

  it('marks owner and admins as full access (not choosable) via decorate', () => {
    const items = memberItems(team, {
      decorate: (x) => (x.role === WorkspaceRole.OWNER || x.role === WorkspaceRole.ADMIN ? { note: 'полный доступ', disabled: true } : undefined),
    });
    expect(items.filter((i) => i.disabled).map((i) => i.userId)).toEqual(['anna', 'boris']);
    expect(items[0]?.note).toBe('полный доступ');
    expect(items.find((i) => i.userId === 'dina')?.guest).toBe(true);
  });

  it('shows the nickname with the profile name muted and finds by either, or by email', () => {
    const items = memberItems(team, { emails: { vera: 'vera@calab.ru' } });
    const gr = items.find((i) => i.userId === 'grigory');
    expect(gr).toMatchObject({ name: 'Гриша', secondary: 'Григорий' });
    expect(filterItems(items, 'григ').map((i) => i.userId)).toEqual(['grigory']);
    expect(filterItems(items, 'ГРИША').map((i) => i.userId)).toEqual(['grigory']);
    expect(filterItems(items, 'vera@').map((i) => i.userId)).toEqual(['vera']);
    expect(items.find((i) => i.userId === 'vera')?.secondary).toBe('vera@calab.ru');
  });

  it('leaves out excluded ids', () => {
    expect(memberItems(team, { exclude: new Set(['anna']) }).map((i) => i.userId)).not.toContain('anna');
  });
});

describe('userItems', () => {
  it('maps server candidates with the shared role', () => {
    const users = [create(UserSchema, { id: 'boris', displayName: 'Борис' })];
    expect(userItems(users, () => WorkspaceRole.ADMIN)[0]).toMatchObject({ userId: 'boris', role: WorkspaceRole.ADMIN, guest: false });
  });
});
