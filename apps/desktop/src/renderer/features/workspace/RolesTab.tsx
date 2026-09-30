import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { PERMISSION_BITS, WorkspaceRole, type Role, type WorkspaceMember } from '@calaba/protocol';
import { AtSign, ChevronLeft, ChevronRight, Crown, GripVertical, Plus, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { confirmAction } from '../../components/Confirm';
import { Badge, Button, Card, Empty, IconButton, Input, Row, Toggle, cx } from '../../components/ui';
import { plural, t, type MessageKey } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import {
  ROLE_NAME_MAX,
  ROLE_PALETTE,
  ROLE_PERM_GROUPS,
  canAssignRole,
  canCreateRole,
  canDeleteRole,
  canEditRole,
  canRenameRole,
  editableBits,
  isCustomRole,
  isFullRole,
  GUEST_BITS,
  parseRoleColor,
  reorderCustom,
  roleActor,
  roleColorCss,
  roleCounts,
  roleNameError,
  rolesOfMember,
  topRole,
  uniqueRoleName,
  type PermGroupId,
  type RoleActor,
  type RoleNameError,
} from '../../lib/roles';
import { useSession } from '../../stores/session';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { roleName } from '../people/MemberBits';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems, type PeoplePickItem } from '../people/memberPickItems';
import { PERM_HINT, PERM_LABEL } from './RoomDialogs';
import { toggleMemberRole } from '../people/actions';
import { nameOf } from '../people/members';

/*
 * Workspace settings → «Роли» (ADR-0026, docs/08 «Роли»): the list (colour, member count,
 * built-ins marked, custom roles dragged into order) and a role card (name, colour, «Упоминаемая»,
 * the permission matrix, members with the role, delete). Changes apply at once (System Settings
 * style); the server re-checks every rule, a refusal (403 / 422) shows inline.
 */

const GROUP_LABEL: Record<PermGroupId, MessageKey> = {
  general: 'roles.group.general',
  invites: 'roles.group.invites',
  rooms: 'roles.group.rooms',
  voice: 'roles.group.voice',
  telephony: 'roles.group.telephony',
  moderation: 'roles.group.moderation',
};

const NAME_ERROR: Record<Exclude<RoleNameError, null>, MessageKey> = {
  empty: 'roles.err.empty',
  long: 'roles.err.long',
  taken: 'roles.err.taken',
};

const err = (e: unknown): string => errorText(e);

/** Me in this workspace as a role actor (lib/roles). */
function useActor(workspaceId: string): RoleActor {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const mine = useMemberRoles(workspaceId, me);
  return useMemo(() => roleActor(mine), [mine]);
}

export function RolesTab({ workspaceId }: { workspaceId: string }): ReactNode {
  const [open, setOpen] = useState<string | null>(null);
  const role = useWorkspaces((s) => (open ? s.byId[workspaceId]?.roles.find((r) => r.id === open) : undefined));
  // A role deleted meanwhile (here or elsewhere) → back to the list.
  if (open && !role) return <RoleList workspaceId={workspaceId} onOpen={setOpen} />;
  return role ? <RoleCard workspaceId={workspaceId} role={role} onBack={() => setOpen(null)} /> : <RoleList workspaceId={workspaceId} onOpen={setOpen} />;
}

/** The glyph before a role name: crown / shield for owner / admin, @ member, guest icon, a colour dot for a custom role. */
function RoleIcon({ role, size = 'md' }: { role: Role; size?: 'md' | 'lg' }): ReactNode {
  const box = size === 'lg' ? 'size-8' : 'size-6';
  if (isCustomRole(role)) {
    return (
      <span className={cx('grid shrink-0 place-items-center', box)} aria-hidden>
        <span className={cx('rounded-full', size === 'lg' ? 'size-4' : 'size-3')} style={{ background: role.color ? roleColorCss(role.color) : 'var(--color-label-tertiary)' }} />
      </span>
    );
  }
  const Icon = role.builtin === WorkspaceRole.OWNER ? Crown : role.builtin === WorkspaceRole.ADMIN ? ShieldCheck : role.builtin === WorkspaceRole.GUEST ? UserRound : AtSign;
  const tone = role.builtin === WorkspaceRole.OWNER ? 'text-role-owner' : role.builtin === WorkspaceRole.ADMIN ? 'text-role-admin' : 'text-muted';
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-full bg-[var(--color-fill)]', box, tone)} aria-hidden>
      <Icon className={size === 'lg' ? 'size-4' : 'size-3.5'} />
    </span>
  );
}

function RoleList({ workspaceId, onOpen }: { workspaceId: string; onOpen: (id: string) => void }): ReactNode {
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const actor = useActor(workspaceId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor));
  const counts = useMemo(() => roleCounts(roles ?? [], Object.values(members ?? {})), [roles, members]);
  if (!roles) return null;

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.roles.create(workspaceId, { name: uniqueRoleName(t('roles.newName'), roles), color: ROLE_PALETTE[0] ?? 0, permissions: 0n, mentionable: false });
      if (r.role) {
        useWorkspaces.getState().upsertRole(r.role);
        onOpen(r.role.id);
      }
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  const onEnd = (e: DragEndEvent): void => {
    const over = e.over?.id;
    if (over === undefined) return;
    const order = reorderCustom(roles, String(e.active.id), String(over));
    if (!order) return;
    // Optimistic: the custom roles take positions n+1 … 2 at once; the answer (or ROLE_UPDATE) confirms.
    const before = roles;
    const pos = new Map(order.map((id, i) => [id, order.length + 1 - i]));
    useWorkspaces.getState().setRoles(workspaceId, roles.map((r) => (pos.has(r.id) ? { ...r, position: pos.get(r.id) ?? r.position } : r)));
    setError(null);
    api.roles.order(workspaceId, order).then(
      (res) => useWorkspaces.getState().setRoles(workspaceId, res.roles),
      (x: unknown) => {
        useWorkspaces.getState().setRoles(workspaceId, before);
        setError(err(x));
      },
    );
  };

  return (
    <>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-caption text-muted">{t('roles.hint')}</p>
        {canCreateRole(actor) ? (
          <Button busy={busy} onClick={() => void create()} data-testid="role-create">
            <Plus className="size-4" aria-hidden /> {t('roles.create')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="roles-error">
          {error}
        </p>
      ) : null}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onEnd}>
        <Card title={plural('roles.count', roles.length)}>
          {roles.map((r) => (
            <RoleRow key={r.id} role={r} count={counts.get(r.id) ?? 0} draggable={isCustomRole(r) && canEditRole(actor, r)} onOpen={() => onOpen(r.id)} />
          ))}
        </Card>
      </DndContext>
    </>
  );
}

function RoleRow({ role, count, draggable, onOpen }: { role: Role; count: number; draggable: boolean; onOpen: () => void }): ReactNode {
  const name = roleName(role);
  const drag = useDraggable({ id: role.id, disabled: !draggable });
  const drop = useDroppable({ id: role.id, disabled: !isCustomRole(role) });
  const ref = (n: HTMLDivElement | null): void => {
    drag.setNodeRef(n);
    drop.setNodeRef(n);
  };
  const style = drag.transform ? { transform: `translate3d(0, ${Math.round(drag.transform.y)}px, 0)` } : undefined;
  return (
    <div
      ref={ref}
      style={style}
      className={cx(
        'relative flex min-h-11 items-center gap-2 bg-[var(--color-card)] pl-1 pr-2',
        drag.isDragging && 'z-10 opacity-90 shadow-[var(--shadow-popover)]',
        drop.isOver && !drag.isDragging && 'shadow-[inset_0_2px_0_var(--color-accent)]',
      )}
      data-testid="role-row"
    >
      {draggable ? (
        <button
          type="button"
          aria-label={t('roles.drag', { name })}
          className="grid size-7 shrink-0 cursor-grab place-items-center rounded-[6px] text-faint hover:bg-hover hover:text-fg active:cursor-grabbing"
          {...drag.listeners}
          {...drag.attributes}
        >
          <GripVertical className="size-4" aria-hidden />
        </button>
      ) : (
        <span className="w-7 shrink-0" aria-hidden />
      )}
      <button type="button" onClick={onOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[6px] pr-1 text-left" aria-label={name}>
        <RoleIcon role={role} />
        <span className="min-w-0 truncate text-body font-medium">
          {name}
        </span>
        {!isCustomRole(role) ? <Badge>{t('roles.builtin')}</Badge> : null}
        {role.mentionable ? <AtSign className="size-3.5 shrink-0 text-faint" aria-label={t('roles.mentionable')} /> : null}
        <span className="ml-auto shrink-0 text-caption text-muted">{plural('roles.nMembers', count)}</span>
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the role card

function RoleCard({ workspaceId, role, onBack }: { workspaceId: string; role: Role; onBack: () => void }): ReactNode {
  const actor = useActor(workspaceId);
  const roles = useWorkspaces((s) => s.byId[workspaceId]?.roles ?? []);
  const [error, setError] = useState<string | null>(null);
  const name = roleName(role);
  const editable = canEditRole(actor, role);
  const bits = editableBits(actor, role);
  const full = isFullRole(role);

  const patch = async (init: Parameters<typeof api.roles.update>[2]): Promise<void> => {
    setError(null);
    try {
      const r = await api.roles.update(workspaceId, role.id, init);
      if (r.role) useWorkspaces.getState().upsertRole(r.role);
    } catch (e) {
      setError(err(e));
    }
  };
  const remove = async (): Promise<void> => {
    if (!(await confirmAction(t('roles.delete'), t('roles.deleteConfirm', { name }), t('roles.delete')))) return;
    setError(null);
    try {
      await api.roles.remove(workspaceId, role.id);
      useWorkspaces.getState().removeRole(workspaceId, role.id);
      onBack();
    } catch (e) {
      setError(err(e));
    }
  };

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onBack} data-testid="role-back">
          <ChevronLeft className="size-4" aria-hidden /> {t('roles.tab')}
        </Button>
        <RoleIcon role={role} size="lg" />
        <h3 className="min-w-0 truncate text-headline font-semibold" data-testid="role-title">
          {name}
        </h3>
        {!isCustomRole(role) ? <Badge>{t('roles.builtin')}</Badge> : null}
      </div>
      {!editable ? <p className="-mt-2 text-caption text-muted">{t('roles.readOnly')}</p> : null}
      {error ? (
        <p role="alert" className="-mt-2 text-caption text-danger-text" data-testid="role-error">
          {error}
        </p>
      ) : null}

      <Card title={t('roles.card.basics')}>
        <Row label={t('roles.name')} {...(!isCustomRole(role) ? { hint: t('roles.nameFixed') } : {})}>
          <RoleNameInput role={role} roles={roles} disabled={!canRenameRole(actor, role)} onCommit={(v) => patch({ name: v })} />
        </Row>
        <div className="flex flex-col gap-2 px-3 py-2.5" data-settings-row>
          <span className="text-body" data-settings-label>
            {t('roles.color')}
          </span>
          <ColorPicker value={role.color} disabled={!editable} onChange={(c) => void patch({ color: c })} />
        </div>
        <Row label={t('roles.mentionable')} hint={t('roles.mentionableHint')}>
          <Toggle label={t('roles.mentionable')} checked={role.mentionable} disabled={!editable} onChange={(v) => void patch({ mentionable: v })} />
        </Row>
      </Card>

      {full ? (
        <Card title={t('roles.perms')}>
          <p className="px-3 py-2.5 text-body text-muted" data-testid="role-full-access">
            {t('roles.fullAccess')}
          </p>
        </Card>
      ) : (
        <PermissionMatrix role={role} editable={bits} onChange={(p) => void patch({ permissions: p })} />
      )}

      <RoleMembers workspaceId={workspaceId} role={role} actor={actor} onError={setError} />

      {canDeleteRole(actor, role) ? (
        <div className="flex justify-end">
          <Button variant="destructive" onClick={() => void remove()} data-testid="role-delete">
            <Trash2 className="size-4" aria-hidden /> {t('roles.delete')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Name field: commits on Enter / blur; the name rules (lib/roles roleNameError) inline, Esc restores. */
function RoleNameInput({ role, roles, disabled, onCommit }: { role: Role; roles: readonly Role[]; disabled: boolean; onCommit: (v: string) => Promise<void> }): ReactNode {
  const shown = roleName(role);
  const [v, setV] = useState(shown);
  const [prev, setPrev] = useState(shown);
  const errId = useId();
  if (prev !== shown) {
    setPrev(shown);
    setV(shown);
  }
  const problem = disabled ? null : roleNameError(v, roles, role.id);
  const commit = (): void => {
    if (disabled || problem || v.trim() === shown) return;
    void onCommit(v.trim());
  };
  return (
    <div className="flex w-60 flex-col items-end gap-1">
      <Input
        aria-label={t('roles.name')}
        value={v}
        disabled={disabled}
        maxLength={ROLE_NAME_MAX * 2}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? errId : undefined}
        data-testid="role-name"
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape' && v !== shown) {
            e.stopPropagation();
            setV(shown);
          }
        }}
      />
      {problem ? (
        <span id={errId} className="text-caption text-danger-text">
          {t(NAME_ERROR[problem], { n: ROLE_NAME_MAX })}
        </span>
      ) : null}
    </div>
  );
}

/** 12 swatches + «Свой цвет» (the system colour picker; a hex field would be one more control). */
function ColorPicker({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (c: number) => void }): ReactNode {
  const custom = value !== 0 && !ROLE_PALETTE.includes(value);
  return (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('roles.color')} data-testid="role-colors">
      {ROLE_PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={roleColorCss(c)}
          disabled={disabled}
          onClick={() => onChange(c)}
          className={cx(
            'size-7 rounded-full outline-offset-2 transition-transform duration-[var(--motion-fast)] enabled:hover:scale-110 disabled:opacity-50',
            value === c && 'ring-2 ring-fg ring-offset-2 ring-offset-[var(--color-card)]',
          )}
          style={{ background: roleColorCss(c) }}
        />
      ))}
      <label
        className={cx(
          'relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-[var(--color-label-tertiary)] text-muted',
          custom && 'border-solid ring-2 ring-fg ring-offset-2 ring-offset-[var(--color-card)]',
          disabled && 'cursor-default opacity-50',
        )}
        style={custom ? { background: roleColorCss(value) } : undefined}
        title={t('roles.colorCustom')}
      >
        {custom ? null : <Plus className="size-3.5" aria-hidden />}
        <input
          type="color"
          aria-label={t('roles.colorCustom')}
          className="absolute inset-0 cursor-pointer opacity-0"
          disabled={disabled}
          value={roleColorCss(value || 0x8e8e93)}
          onChange={(e) => {
            const c = parseRoleColor(e.target.value);
            if (c !== null && c !== value) onChange(c);
          }}
        />
      </label>
    </div>
  );
}

/** Общие / Комнаты / Голос / Модерация: a checkbox per permission; the guest role lists only the guest bits. */
function PermissionMatrix({ role, editable, onChange }: { role: Role; editable: bigint; onChange: (p: bigint) => void }): ReactNode {
  const guest = role.builtin === WorkspaceRole.GUEST;
  return (
    <>
      {guest ? <p className="-mb-2 px-1 text-caption text-muted">{t('roles.guestNote')}</p> : null}
      {ROLE_PERM_GROUPS.map((g) => {
        const perms = g.perms.filter((p) => !guest || (PERMISSION_BITS[p] & GUEST_BITS) !== 0n);
        if (perms.length === 0) return null;
        return (
          <Card key={g.id} title={t(GROUP_LABEL[g.id])}>
            {perms.map((p) => {
              const bit = PERMISSION_BITS[p];
              const on = (role.permissions & bit) !== 0n;
              const can = (editable & bit) !== 0n;
              const id = `perm-${role.id}-${p}`;
              return (
                <Row key={p} label={t(PERM_LABEL[p])} hint={PERM_HINT[p] ? t(PERM_HINT[p]) : undefined} htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={on}
                    disabled={!can}
                    data-testid={`role-perm-${p}`}
                    onChange={(e) => onChange(e.target.checked ? role.permissions | bit : role.permissions & ~bit)}
                    className="size-[18px] cursor-pointer rounded-[4px] accent-[var(--color-accent-strong)] disabled:cursor-default disabled:opacity-50"
                  />
                </Row>
              );
            })}
          </Card>
        );
      })}
    </>
  );
}

/**
 * «Участники с ролью»: who holds it, × to take it, «Добавить участника» through the member picker
 * (docs/08 «Выбор участника»). Member / guest follow the member itself: just a note.
 */
function RoleMembers({ workspaceId, role, actor, onError }: { workspaceId: string; role: Role; actor: RoleActor; onError: (e: string | null) => void }): ReactNode {
  const entry = useWorkspaces((s) => s.byId[workspaceId]);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const [adding, setAdding] = useState(false);
  const all = entry?.roles;
  const list = useMemo(() => {
    if (!entry || !all) return [];
    return Object.values(entry.members)
      .filter((m) => m.user && rolesOfMember(all, m).some((r) => r.id === role.id))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [entry, all, role.id]);
  if (!entry || !all) return null;
  if (role.builtin === WorkspaceRole.MEMBER || role.builtin === WorkspaceRole.GUEST) {
    return (
      <Card title={t('roles.members')}>
        <p className="px-3 py-2.5 text-body text-muted">{t(role.builtin === WorkspaceRole.GUEST ? 'roles.everyGuest' : 'roles.everyMember')}</p>
      </Card>
    );
  }
  const assignable = (m: WorkspaceMember): boolean => {
    const theirs = rolesOfMember(all, m);
    return canAssignRole(actor, role, topRole(theirs)?.position ?? -1, m.user?.id === me) && !(role.builtin === WorkspaceRole.ADMIN && m.role === WorkspaceRole.GUEST);
  };
  const held = new Set(list.map((m) => m.user?.id ?? ''));
  const items = memberItems(Object.values(entry.members), {
    exclude: held,
    roles: all,
    decorate: (m) => (assignable(m) ? undefined : { disabled: true }),
  });
  const choosable = items.some((i) => !i.disabled);
  const set = (userId: string, on: boolean): void => {
    onError(null);
    void toggleMemberRole(workspaceId, userId, role, on);
  };
  const pick = (item: PeoplePickItem): void => {
    setAdding(false);
    if (item.kind === 'member') set(item.userId, true);
  };
  return (
    <Card title={`${t('roles.members')} · ${list.length}`}>
      {list.length === 0 ? <Empty>{t('roles.noMembers')}</Empty> : null}
      {list.map((m) => {
        const u = m.user;
        if (!u) return null;
        const n = nameOf(m) || u.displayName;
        return (
          <div key={u.id} className="flex min-h-11 items-center gap-2.5 px-3 py-1.5" data-testid="role-member">
            <Avatar userId={u.id} name={n} fileId={u.avatarFileId || undefined} size={24} presence />
            <span className="min-w-0 flex-1 truncate text-body">{n}</span>
            {assignable(m) ? (
              <IconButton label={t('roles.removeMember', { name: n })} className="text-muted hover:text-danger" onClick={() => set(u.id, false)}>
                <X className="size-4" />
              </IconButton>
            ) : null}
          </div>
        );
      })}
      {choosable ? (
        <div className="px-3 py-2">
          <MemberPicker
            open={adding}
            onOpenChange={setAdding}
            groups={[{ id: 'members', label: '', items }]}
            onSelect={pick}
            placeholder={t('picker.searchPeople')}
            label={t('roles.addMember')}
            testId="role-member-picker"
          >
            <Button variant="secondary" size="sm" data-testid="role-add-member">
              <Plus className="size-3.5" aria-hidden /> {t('roles.addMember')}
            </Button>
          </MemberPicker>
        </div>
      ) : null}
    </Card>
  );
}

