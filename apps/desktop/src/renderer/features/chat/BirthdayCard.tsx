import type { BirthdayCard as Card } from '@calaba/protocol';
import type { ReactNode } from 'react';
import { t } from '../../i18n';
import { formatBirthday } from '../../lib/birthday';
import { useMemberName } from '../../stores/workspaces';
import { openProfile } from '../people/actions';

/**
 * «🎂 Сегодня день рождения у <имя>!» (docs/09 #76): a system card the server posts at 09:00 of
 * the person's zone into the workspace's first text room. Same frame as the recording card
 * (docs/08 «Запись встреч»); the name opens the profile.
 */
export function BirthdayCardView({ authorId, card, workspaceId }: { authorId: string; card: Card; workspaceId: string }): ReactNode {
  const name = useMemberName(workspaceId, authorId);
  const text = t('birthday.card', { name });
  const [before, after] = text.split(name, 2) as [string, string | undefined];
  return (
    <article
      aria-label={`🎂 ${text}`}
      data-testid="birthday-card"
      className="flex w-full items-center gap-3 rounded-[var(--radius-card)] border border-line bg-[var(--color-card)] px-4 py-3 shadow-[var(--shadow-card)] mobile:px-3"
    >
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-warn)_16%,transparent)] text-[20px] leading-none">
        🎂
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="min-w-0 text-body">
          {before}
          {after !== undefined ? (
            <button
              type="button"
              className="rounded-[var(--radius-control)] font-semibold hover:underline"
              onClick={() => (workspaceId ? openProfile(workspaceId, authorId) : undefined)}
            >
              {name}
            </button>
          ) : null}
          {after}
        </p>
        {card.day && card.month ? <span className="text-caption text-muted">{formatBirthday({ day: card.day, month: card.month })}</span> : null}
      </div>
    </article>
  );
}
