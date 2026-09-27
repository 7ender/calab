import { WorkspaceRole } from '@calaba/protocol';
import { Crown, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cx } from '../../components/ui';
import { t } from '../../i18n';
import { useWorkspaces } from '../../stores/workspaces';

/** «Гость» next to a name (ADR-0016): the shared badge (11/600, sentence case, radius 4). */
export function GuestBadge({ className }: { className?: string }): ReactNode {
  return <Badge {...(className ? { className } : {})}>{t('people.guest')}</Badge>;
}

/**
 * How a role mark / name is coloured: `role` = the role token (default), `muted` = secondary
 * (offline rows), `inherit` = the surrounding text colour (a selected row on the accent fill).
 */
export type RoleTone = 'role' | 'muted' | 'inherit';

/**
 * Name colour per role (docs/09 #26; tokens --color-role-*, ≥ 4.5:1 on the sidebar incl. hover
 * and on the light cards): owner gold, admin accent, everyone else the plain label colour.
 */
export function roleTextClass(role: WorkspaceRole | undefined, tone: RoleTone = 'role'): string {
  if (tone === 'muted') return 'text-muted';
  if (tone === 'inherit') return '';
  if (role === WorkspaceRole.OWNER) return 'text-role-owner';
  if (role === WorkspaceRole.ADMIN) return 'text-role-admin';
  return 'text-fg';
}

/** Owner and admins carry a mark; members and guests don't (the guest badge is separate). */
export const hasRoleMark = (role: WorkspaceRole | undefined): boolean => role === WorkspaceRole.OWNER || role === WorkspaceRole.ADMIN;

/**
 * The one role mark next to a name (docs/09 #26, docs/08 «Роли в списках»): a crown for the
 * owner, a 14 px shield for admins, in the role colour; the tooltip (and accessible name) is the
 * role — «Владелец» / «Администратор» — or `label` when the context needs more (the DM header
 * names the workspace). The speaking ring lives on the avatar, the role on the name: no clash.
 */
export function RoleMark({
  role,
  tone = 'role',
  label,
  className,
}: {
  role: WorkspaceRole | undefined;
  tone?: RoleTone;
  label?: string;
  className?: string;
}): ReactNode {
  if (!hasRoleMark(role)) return null;
  const owner = role === WorkspaceRole.OWNER;
  const Icon = owner ? Crown : ShieldCheck;
  const title = label ?? t(owner ? 'role.owner' : 'role.admin');
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-role-mark={owner ? 'owner' : 'admin'}
      className={cx('inline-flex shrink-0', roleTextClass(role, tone), className)}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}

/**
 * The DM peer's most senior role among the workspaces we share (a DM has no workspace of its
 * own, ADR-0020): owner before admin; `null` when they are neither anywhere. Selectors return
 * primitives only (zustand re-renders on a new object every time).
 */
export function useSharedRole(userId: string): { role: WorkspaceRole; workspace: string } | null {
  const wsId = useWorkspaces((s) => {
    let best = '';
    let rank = 2;
    for (const [id, e] of Object.entries(s.byId)) {
      const r = e.members[userId]?.role;
      const k = r === WorkspaceRole.OWNER ? 0 : r === WorkspaceRole.ADMIN ? 1 : 2;
      if (k < rank) {
        rank = k;
        best = id;
      }
    }
    return best;
  });
  const role = useWorkspaces((s) => (wsId ? s.byId[wsId]?.members[userId]?.role : undefined));
  const workspace = useWorkspaces((s) => (wsId ? (s.byId[wsId]?.ws.name ?? '') : ''));
  return role !== undefined && hasRoleMark(role) ? { role, workspace } : null;
}
