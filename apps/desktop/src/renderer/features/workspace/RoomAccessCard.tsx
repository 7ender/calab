import { create } from '@bufbuild/protobuf';
import { PERMISSION_BITS, PermissionTargetType, RoomPermissionOverrideSchema, WorkspaceRole, type Room } from '@calaba/protocol';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Button, Empty, IconButton, Card, Row, Toggle } from '../../components/ui';
import type { PickerGroup } from '../../components/picker/pickerModel';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { compactDrafts, toDrafts, withTri, type OverrideDraft } from '../../lib/permissions';
import { roleColorCss } from '../../lib/roles';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { memberName, useWorkspaces } from '../../stores/workspaces';
import { RoleMark, roleName } from '../people/MemberBits';
import { MemberPicker } from '../people/MemberPicker';
import { memberItems, type PeoplePickItem, type RolePickItem } from '../people/memberPickItems';

/*
 * Private room → «Доступ» (ADR-0029, docs/09 #46): the owner's «Только по списку» switch and the
 * «Кто видит» list — the room's existing `allow VIEW_ROOM` overrides for people and roles, edited
 * in place. With the switch on, admins see the room only when they are on the list; the owner
 * always does. The server checks everything (PATCH restricted: owner only, 403 OWNER_ONLY).
 */

const VIEW = PERMISSION_BITS.VIEW_ROOM;

/** Roles a room list may name: custom roles and «admin» — not the owner (always in) or member / guest (that would open the room to all). */
const listableRole = (b: WorkspaceRole): boolean => b === WorkspaceRole.UNSPECIFIED || b === WorkspaceRole.ADMIN;

export function RoomAccessCard({ room }: { room: Room }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const entry = useWorkspaces((s) => s.byId[room.workspaceId]);
  const ownerId = entry?.ws.ownerId ?? '';
  const isOwner = ownerId !== '' && ownerId === me;
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const listed = useMemo(() => room.permissionOverrides.filter((o) => (o.allow & VIEW) === VIEW), [room.permissionOverrides]);
  const wsRoles = useMemo(() => entry?.roles ?? [], [entry?.roles]);

  const pickGroups = useMemo((): Array<PickerGroup<PeoplePickItem>> => {
    const inList = new Set(listed.map((o) => `${o.targetType}:${o.targetId}`));
    const roles: RolePickItem[] = wsRoles
      .filter((r) => listableRole(r.builtin) && !inList.has(`${PermissionTargetType.ROLE}:${r.id}`))
      .map((r) => ({ kind: 'role', id: `role:${r.id}`, roleId: r.id, role: r.builtin, color: r.color, label: roleName(r), note: '', search: [roleName(r), r.name] }));
    const people = memberItems(Object.values(entry?.members ?? {}), {
      roles: wsRoles,
      exclude: new Set([ownerId, ...listed.filter((o) => o.targetType === PermissionTargetType.USER).map((o) => o.targetId)]),
    });
    return [
      { id: 'roles', label: t('picker.roles'), items: roles },
      { id: 'members', label: t('picker.members'), items: people },
    ];
  }, [entry?.members, listed, ownerId, wsRoles]);

  const run = (p: Promise<unknown>): void => {
    setBusy(true);
    void p.catch((e: unknown) => toast.error(errorText(e))).finally(() => setBusy(false));
  };
  const setRestricted = (v: boolean): void =>
    run(api.rooms.update(room.id, { restricted: v }).then((r) => r.room && useRooms.getState().upsert(r.room)));
  // The list is the VIEW_ROOM bit of the overrides: add = allow, remove = inherit (other bits stay).
  const setView = (targetType: PermissionTargetType, targetId: string, on: boolean): void => {
    const drafts = toDrafts(room.permissionOverrides);
    const key = (d: OverrideDraft): boolean => d.targetType === targetType && d.targetId === targetId;
    const base = drafts.some(key) ? drafts : [...drafts, { targetType, targetId, allow: 0n, deny: 0n }];
    const next = compactDrafts(base.map((d) => (key(d) ? withTri(d, VIEW, on ? 'allow' : 'inherit') : d)));
    run(
      api.rooms
        .setPermissions(room.id, { overrides: next.map((d) => create(RoomPermissionOverrideSchema, d)) })
        .then((r) => r.room && useRooms.getState().upsert(r.room)),
    );
  };
  const pick = (item: PeoplePickItem): void => {
    setAdding(false);
    if (item.kind === 'role') setView(PermissionTargetType.ROLE, item.roleId, true);
    else setView(PermissionTargetType.USER, item.userId, true);
  };

  const owner = entry?.members[ownerId];
  const ownerName = owner ? memberName(room.workspaceId, ownerId) : '';
  return (
    <Card title={t('room.accessCard')} footer={t('room.whoSeesFooter', { perm: t('perm.VIEW_ROOM'), tab: t('room.tabPerms') })}>
      <Row label={t('room.restricted')} hint={isOwner ? t('room.restrictedHint') : t('room.restrictedOwner')}>
        <Toggle label={t('room.restricted')} checked={room.restricted} disabled={!isOwner || busy} onChange={setRestricted} />
      </Row>
      <div className="flex flex-col px-3 py-2" data-testid="room-who-sees">
        <span className="pb-1 text-caption font-medium text-muted">{t('room.whoSees')}</span>
        {owner ? (
          <div className="flex min-h-9 items-center gap-2.5">
            <Avatar userId={ownerId} name={ownerName} fileId={owner.user?.avatarFileId || undefined} size={24} />
            <span className="min-w-0 flex-1 truncate text-body">{ownerName}</span>
            <span className="text-caption text-faint">{t('room.whoSeesOwner')}</span>
          </div>
        ) : null}
        {listed.length === 0 ? <Empty>{t('room.whoSeesEmpty')}</Empty> : null}
        {listed.map((o) => {
          const role = o.targetType === PermissionTargetType.ROLE ? wsRoles.find((r) => r.id === o.targetId) : undefined;
          const label = role ? `@${roleName(role)}` : memberName(room.workspaceId, o.targetId);
          const m = o.targetType === PermissionTargetType.USER ? entry?.members[o.targetId] : undefined;
          return (
            <div key={`${o.targetType}:${o.targetId}`} className="flex min-h-9 items-center gap-2.5" data-testid="room-who-sees-row">
              {role ? (
                <span className="grid size-6 shrink-0 place-items-center" aria-hidden>
                  <span className="size-2.5 rounded-full" style={{ background: role.color ? roleColorCss(role.color) : 'var(--color-label-tertiary)' }} />
                </span>
              ) : (
                <Avatar userId={o.targetId} name={label} fileId={m?.user?.avatarFileId || undefined} size={24} />
              )}
              <span className="min-w-0 flex-1 truncate text-body">{label}</span>
              {role ? <RoleMark role={role.builtin} /> : null}
              {isOwner ? (
                <IconButton label={t('room.whoSeesRemove', { name: label })} className="text-muted hover:text-danger" disabled={busy} onClick={() => setView(o.targetType, o.targetId, false)}>
                  <X className="size-4" />
                </IconButton>
              ) : null}
            </div>
          );
        })}
        {isOwner ? (
          <div className="pt-1.5">
            <MemberPicker
              open={adding}
              onOpenChange={setAdding}
              groups={pickGroups}
              onSelect={pick}
              placeholder={t('picker.searchPeople')}
              label={t('room.whoSeesAdd')}
              testId="room-who-sees-picker"
            >
              <Button variant="secondary" size="sm" disabled={busy} data-testid="room-who-sees-add">
                <Plus className="size-3.5" aria-hidden /> {t('room.whoSeesAdd')}
              </Button>
            </MemberPicker>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
