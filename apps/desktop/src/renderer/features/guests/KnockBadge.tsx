import { Hand } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { Tip } from '../../components/ui';
import { t, useLocale } from '../../i18n';
import { useKnockCount } from './stores/admissions';

/**
 * Knock counter on a room row in the sidebar (ADR-0040 §5): guests waiting for approval — a hand
 * and the number on the accent fill, so it never reads as unread (white bar) or mentions (red).
 * Only deciders get knocks, so only they see it. Its own subscriber: a knock re-renders this badge,
 * not the row. Hides on row hover like the mention badge (the row actions take the place).
 */
export const KnockBadge = memo(function KnockBadge({ roomId }: { roomId: string }): ReactNode {
  useLocale();
  const n = useKnockCount(roomId);
  if (n <= 0) return null;
  const label = t('adm.counter', { n });
  return (
    <Tip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid="room-knocks"
        className="inline-flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-accent-strong pl-1 pr-1.5 text-micro font-bold leading-4 text-accent-fg group-hover/row:hidden"
      >
        <Hand className="size-2.5" strokeWidth={2.25} aria-hidden />
        {n > 99 ? '99+' : n}
      </span>
    </Tip>
  );
});
