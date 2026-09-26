import { WorkspaceRole } from '@calaba/protocol';
import { Crown, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, cx } from '../../components/ui';
import { t } from '../../i18n';

/** «Гость» next to a name (ADR-0016): the shared badge (11/600, sentence case, radius 4). */
export function GuestBadge({ className }: { className?: string }): ReactNode {
  return <Badge {...(className ? { className } : {})}>{t('people.guest')}</Badge>;
}

/** Name colour per role (tokens --color-role-*; ≥ 4.5:1 on the sidebar incl. hover). */
export function roleTextClass(role: WorkspaceRole | undefined): string {
  if (role === WorkspaceRole.OWNER) return 'text-role-owner';
  if (role === WorkspaceRole.ADMIN) return 'text-role-admin';
  return 'text-fg';
}

/** Crown for the owner, shield for admins (monochrome in the role colour). */
export function RoleIcon({ role, className }: { role: WorkspaceRole | undefined; className?: string }): ReactNode {
  if (role === WorkspaceRole.OWNER)
    return <Crown className={cx('size-3.5 shrink-0 text-role-owner', className)} aria-label={t('people.owner')} role="img" />;
  if (role === WorkspaceRole.ADMIN)
    return <ShieldCheck className={cx('size-3.5 shrink-0 text-role-admin', className)} aria-label={t('role.admin')} role="img" />;
  return null;
}
