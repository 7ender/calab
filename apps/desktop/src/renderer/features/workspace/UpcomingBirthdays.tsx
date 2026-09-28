import type { ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { Card } from '../../components/ui';
import { plural, t } from '../../i18n';
import { formatBirthday } from '../../lib/birthday';
import { useWorkspaces } from '../../stores/workspaces';
import { useUpcomingBirthdays } from '../people/upcomingBirthdays';

/** «Сегодня» / «Завтра» / «Через 3 дня». */
export function whenLabel(inDays: number): string {
  if (inDays === 0) return t('birthday.whenToday');
  if (inDays === 1) return t('birthday.whenTomorrow');
  return plural('birthday.inDays', inDays);
}

/**
 * «Настройки пространства → Участники → Ближайшие дни рождения» (docs/09 #76): members whose
 * birthday is within 7 days (GET /api/workspaces/{id}/birthdays, hidden ones excluded). Shown
 * only when there is someone: an empty section would only push the member list down.
 */
export function UpcomingBirthdays({ workspaceId }: { workspaceId: string }): ReactNode {
  const upcoming = useUpcomingBirthdays(workspaceId);
  const members = useWorkspaces((s) => s.byId[workspaceId]?.members);
  const list = (upcoming ?? []).filter((b) => b.birthday && members?.[b.userId]?.user);
  if (list.length === 0) return null;
  return (
    <Card title={t('birthday.upcoming')} footer={t('birthday.upcomingHint')}>
      {list.map((b) => {
        const m = members?.[b.userId];
        const u = m?.user;
        if (!u || !b.birthday) return null;
        const name = m.nickname || u.displayName;
        return (
          <div key={b.userId} className="flex min-h-12 items-center gap-3 px-3 py-2" data-testid="upcoming-birthday">
            <Avatar userId={u.id} name={name} fileId={u.avatarFileId || undefined} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium">{name}</div>
              <div className="truncate text-caption text-muted">🎂 {formatBirthday(b.birthday)}</div>
            </div>
            <span className={b.inDays === 0 ? 'text-caption font-semibold text-accent-text' : 'text-caption text-muted'}>{whenLabel(b.inDays)}</span>
          </div>
        );
      })}
    </Card>
  );
}
