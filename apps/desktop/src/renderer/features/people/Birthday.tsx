import { useSyncExternalStore, type ReactNode } from 'react';
import type { Birthday } from '@calaba/protocol';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { birthdayLine, dateIn, isBirthdayToday } from '../../lib/birthday';
import { localTimeZone } from '../../lib/timezone';
import { useSession } from '../../stores/session';
import { useWorkspaces } from '../../stores/workspaces';
import { clockFor } from '../shell/voiceFormat';

/**
 * A member's birthday (docs/09 #76). Mine comes from the session (it has the hidden one too),
 * everyone else's from the users map (a hidden birthday never reaches it).
 */
function useBirthday(userId: string): { b: Birthday | undefined; tz: string } {
  const own = useSession((s) => (s.me?.user?.id === userId ? s.me.user.birthday : undefined));
  const theirs = useWorkspaces((s) => s.users[userId]?.birthday);
  const tz = useWorkspaces((s) => s.users[userId]?.timezone ?? '');
  return { b: own ?? theirs, tz };
}

/**
 * Whether it is their birthday now, re-checked on the shared 60 s ticker; the snapshot is a
 * boolean, so a tick re-renders nothing unless the day turns (Ререндеры под контролем).
 */
function useBirthdayToday(b: Birthday | undefined, tz: string): boolean {
  const tk = clockFor(b ? 60_000 : 0);
  const snap = (): boolean => isBirthdayToday(b, tz, new Date(tk.now));
  return useSyncExternalStore(tk.subscribe, snap, snap);
}

/** The date line text on the person's calendar day (their age as of their today). */
function useLine(b: Birthday | undefined, tz: string): string | null {
  const tk = clockFor(b ? 60_000 : 0);
  const snap = (): number => {
    const d = dateIn(new Date(tk.now), tz || localTimeZone());
    return d.y * 10_000 + d.m * 100 + d.d; // a primitive: re-render only when the day turns
  };
  const today = useSyncExternalStore(tk.subscribe, snap, snap);
  if (!b?.day || !b.month) return null;
  return birthdayLine(b, { y: Math.floor(today / 10_000), m: Math.floor(today / 100) % 100, d: today % 100 });
}

/** 🎂 after a name on their birthday (members list, voice rows): a small mark, like the role one. */
export function BirthdayMark({ userId, className }: { userId: string; className?: string }): ReactNode {
  const { b, tz } = useBirthday(userId);
  const today = useBirthdayToday(b, tz);
  if (!today) return null;
  return (
    <span role="img" aria-label={t('birthday.today')} title={t('birthday.today')} data-testid="birthday-mark" className={cx('shrink-0 text-[12px] leading-none', className)}>
      🎂
    </span>
  );
}

/**
 * «🎂 15 марта · 30 лет» in the profile (docs/09 #76): `row` is a dt/dd pair of the profile
 * card's list, `line` sits under the name in the profile dialog. Nothing without a birthday.
 */
export function BirthdayInfo({ userId, variant }: { userId: string; variant: 'row' | 'line' }): ReactNode {
  const { b, tz } = useBirthday(userId);
  const line = useLine(b, tz);
  if (!line) return null;
  if (variant === 'row') {
    return (
      <>
        <dt className="text-muted">{t('birthday.title')}</dt>
        <dd className="min-w-0 truncate" data-testid="birthday">
          {line}
        </dd>
      </>
    );
  }
  return (
    <div className="mt-1 truncate text-body" title={t('birthday.title')} data-testid="birthday">
      {line}
    </div>
  );
}
