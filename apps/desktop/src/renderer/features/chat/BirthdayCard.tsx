import type { BirthdayCard as Card } from '@calaba/protocol';
import { memo, type ReactNode } from 'react';
import { Avatar } from '../../components/Avatar';
import { t } from '../../i18n';
import { formatBirthday } from '../../lib/birthday';
import { useMemberName, useWorkspaces } from '../../stores/workspaces';
import { openProfile } from '../people/actions';

/**
 * «Сегодня день рождения!» (docs/09 #76, #84 / issue #18): a system card the server posts at
 * 09:00 of the person's zone into the workspace's first text room. A festive full-width card:
 * static accent → raspberry gradient (`.birthday-card`, white text ≥ 4.5:1 in both themes), a
 * large 🎂, the title, then avatar + **name** (opens the profile) · date. The sparkles and the cake
 * «pop» run once on mount (≤ 1.2 s, none with prefers-reduced-motion) — no loops.
 */
export const BirthdayCardView = memo(function BirthdayCardView({ authorId, card, workspaceId }: { authorId: string; card: Card; workspaceId: string }): ReactNode {
  const name = useMemberName(workspaceId, authorId);
  const avatarFileId = useWorkspaces((s) => s.users[authorId]?.avatarFileId || undefined);
  const date = card.day && card.month ? formatBirthday({ day: card.day, month: card.month }) : '';
  return (
    <article
      aria-label={t('birthday.card', { name })}
      data-testid="birthday-card"
      className="birthday-card relative flex w-full items-center gap-4 overflow-hidden rounded-[var(--radius-card)] px-5 py-4 text-white shadow-[var(--shadow-card)] mobile:gap-3 mobile:px-3 mobile:py-3"
    >
      <span aria-hidden className="birthday-cake shrink-0 text-[36px] leading-none mobile:text-[30px]">
        🎂
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-headline font-semibold">{t('birthday.cardTitle')}</p>
        <p className="flex min-w-0 items-center gap-2 text-body">
          <Avatar userId={authorId} name={name} fileId={avatarFileId} size={20} />
          <button
            type="button"
            className="birthday-name min-w-0 truncate rounded-[var(--radius-control)] font-semibold hover:underline"
            onClick={() => (workspaceId ? openProfile(workspaceId, authorId) : undefined)}
          >
            {name}
          </button>
          {date ? (
            <span className="shrink-0">
              <span aria-hidden>· </span>
              {date}
            </span>
          ) : null}
        </p>
      </div>
    </article>
  );
});
