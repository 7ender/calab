import { useState, type ReactNode } from 'react';
import { Select } from '../../components/ui';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { useSession } from '../../stores/session';
import { toast } from '../../stores/toasts';
import { rolesOf, useBadgeList, useMemberBadge, useWorkspaces } from '../../stores/workspaces';
import { BadgeImage } from './MemberBadge';
import { canSetMemberBadge } from './members';

/**
 * The member's badge in a profile (docs/09 #82, docs/08 «Бейдж»): the 20 px picture and its name
 * as text, under the name. Nothing without a badge.
 */
export function ProfileBadge({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const badge = useMemberBadge(workspaceId, userId);
  if (!badge) return null;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-1.5 text-caption text-muted" data-testid="profile-badge">
      <BadgeImage fileId={badge.fileId} name={badge.name} size={20} />
      <span className="truncate">{badge.name}</span>
    </div>
  );
}

/**
 * «Бейдж» select in the member profile (docs/09 #82), for who may set it (canSetMemberBadge:
 * MANAGE_NICKNAMES + hierarchy, not bots) and only when the workspace has badges. «Нет» clears.
 * A boolean selector for the right, the library by shallow list: presence / voice changes of the
 * workspace do not re-render it.
 */
export function EditBadge({ workspaceId, userId }: { workspaceId: string; userId: string }): ReactNode {
  const me = useSession((s) => s.me?.user?.id ?? '');
  const allowed = useWorkspaces((s) => {
    const e = s.byId[workspaceId];
    const m = e?.members[userId];
    return !!m && canSetMemberBadge(rolesOf(e, me), rolesOf(e, userId), m, userId === me);
  });
  const current = useWorkspaces((s) => s.byId[workspaceId]?.members[userId]?.badgeId ?? '');
  const badges = useBadgeList(workspaceId);
  const [busy, setBusy] = useState(false);
  if (!allowed || badges.length === 0) return null;
  const set = async (badgeId: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.badges.setMember(workspaceId, userId, badgeId);
      if (r.member) useWorkspaces.getState().upsertMember(r.member);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="mt-2 flex items-center gap-2 text-caption text-muted">
      <span className="shrink-0">{t('badges.member')}</span>
      <Select
        aria-label={t('badges.member')}
        data-testid="profile-badge-select"
        className="w-48"
        value={badges.some((b) => b.id === current) ? current : ''}
        disabled={busy}
        onChange={(e) => void set(e.target.value)}
      >
        <option value="">{t('badges.none')}</option>
        {badges.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </Select>
    </label>
  );
}
