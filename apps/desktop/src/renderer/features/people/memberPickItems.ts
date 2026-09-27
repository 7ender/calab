import { WorkspaceRole, type Role, type User, type WorkspaceMember } from '@calaba/protocol';
import { customLook, rolesOfMember } from '../../lib/roles';
import { getLocale } from '../../i18n';
import type { PickerItem } from '../../components/picker/pickerModel';
import { nameOf, roleRank } from './members';

/*
 * Items of the member picker (docs/08 «Выбор участника»): workspace members and roles. Pure —
 * the rows (MemberPicker.tsx) read presence and avatars from the stores themselves.
 */

export interface MemberPickItem extends PickerItem {
  kind: 'member';
  userId: string;
  /** Workspace nickname, else the profile name. */
  name: string;
  /** Muted second part: the profile name when a nickname is shown, or the email when known. */
  secondary: string;
  avatarFileId: string;
  role: WorkspaceRole | undefined;
  /** The custom role colouring the name (ADR-0026; none for owner / admins). */
  custom?: Role | undefined;
  guest: boolean;
  /** Muted note at the end of the row («полный доступ», «в списке»). */
  note: string;
}

export interface RolePickItem extends PickerItem {
  kind: 'role';
  /** Built-in kind (UNSPECIFIED = a custom role, ADR-0026). */
  role: WorkspaceRole;
  /** Role id (a room override target, PUT …/members/{uid}/roles). */
  roleId: string;
  /** 0xRRGGBB, 0 = none (custom roles show a dot in it). */
  color: number;
  label: string;
  note: string;
}

export type PeoplePickItem = MemberPickItem | RolePickItem;

export interface MemberItemOpts {
  /** User ids left out entirely. */
  exclude?: ReadonlySet<string>;
  /** Note / disabled per member (e.g. owner and admins: «полный доступ», not choosable). */
  decorate?: (m: WorkspaceMember) => { note?: string; disabled?: boolean } | undefined;
  /** Emails by user id, where the caller knows them (the server does not send others' emails). */
  emails?: Readonly<Record<string, string>>;
  /** Workspace roles (ADR-0026): names coloured by the member's custom role. */
  roles?: readonly Role[];
}

/** Workspace members → picker items: owner → admins → members → guests, then by name. */
export function memberItems(members: readonly WorkspaceMember[], opts: MemberItemOpts = {}): MemberPickItem[] {
  const list = members.filter((m) => m.user && !opts.exclude?.has(m.user.id));
  list.sort((a, b) => roleRank(a.role) - roleRank(b.role) || nameOf(a).localeCompare(nameOf(b), getLocale()));
  return list.map((m) => {
    const u = m.user as User;
    const name = nameOf(m) || u.id;
    const email = opts.emails?.[u.id] ?? '';
    const secondary = m.nickname && m.nickname !== u.displayName ? u.displayName : email;
    const extra = opts.decorate?.(m);
    return {
      kind: 'member',
      id: u.id,
      userId: u.id,
      name,
      secondary,
      avatarFileId: u.avatarFileId,
      role: m.role,
      custom: opts.roles ? customLook(rolesOfMember(opts.roles, m)) : undefined,
      guest: m.role === WorkspaceRole.GUEST,
      note: extra?.note ?? '',
      search: [m.nickname, u.displayName, email].filter(Boolean),
      ...(extra?.disabled ? { disabled: true } : {}),
    };
  });
}

/** Users from a server search (new DM candidates) → items; `roleOf` gives the most senior shared role. */
export function userItems(users: readonly User[], roleOf: (userId: string) => WorkspaceRole | undefined = () => undefined): MemberPickItem[] {
  return users.map((u) => ({
    kind: 'member',
    id: u.id,
    userId: u.id,
    name: u.displayName,
    secondary: '',
    avatarFileId: u.avatarFileId,
    role: roleOf(u.id),
    guest: u.isGuest,
    note: '',
    search: [u.displayName],
  }));
}
