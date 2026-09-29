import { memo, useMemo, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { justJoinedUntil } from '../../lib/justJoined';
import { useDeadlinePassed } from '../shell/voiceFormat';

/**
 * «Только вошёл» (owner, 29.09; docs/08 «Голосовые строки»): a quiet 6 px muted-accent dot next to
 * a voice participant's avatar for 10 s after they joined the room, then a 300 ms fade (finite
 * CSS transition; `prefers-reduced-motion` zeroes it globally). `joinedAt` is VoiceState.joined_at
 * in ms — the earliest join of the user's devices, so reconnects don't restart it.
 *
 * A leaf with one timer to the end of the window (useDeadlinePassed) — no ticking clock, and a
 * single deferred re-render of this dot only. A row that mounts outside the window renders
 * nothing and schedules nothing; after the fade the invisible dot stays mounted instead of a
 * second timer to remove it. The caller positions it (`className`: absolute, left of the avatar).
 */
export const JustJoinedDot = memo(function JustJoinedDot({ joinedAt, className }: { joinedAt: number; className?: string }): ReactNode {
  // Evaluated once per join time (not on every re-render): a row mounted mid-window gets the rest.
  const until = useMemo(() => justJoinedUntil(joinedAt, Date.now()), [joinedAt]);
  const passed = useDeadlinePassed(until);
  if (until === null) return null;
  return (
    <span
      aria-hidden
      data-testid="just-joined-dot"
      data-shown={!passed || undefined}
      className={cx('pointer-events-none size-1.5 shrink-0 rounded-full bg-accent/60 transition-opacity duration-300', passed ? 'opacity-0' : 'opacity-100', className)}
    />
  );
});
