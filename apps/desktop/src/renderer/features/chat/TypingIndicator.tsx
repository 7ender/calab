import { useEffect, useState, type ReactNode } from 'react';
import { plural, t } from '../../i18n';
import { useTyping } from '../../stores/typing';
import { memberName } from '../../stores/workspaces';

const NONE: Record<string, number> = {};

/** «Bob печатает…» for the room header (Telegram shows it instead of the subtitle); '' when nobody types. */
export function useTypingText(workspaceId: string, roomId: string): string {
  const typing = useTyping((s) => s.rooms[roomId] ?? NONE);
  // Expired entries are removed by the dispatcher (a timer per TYPING_START); this only re-filters
  // at the next expiry in case that timer is late. One wake-up per expiry, not a 1 s tick: the
  // tick re-rendered the whole room header every second while anyone typed (docs/14).
  const [now, setNow] = useState(() => Date.now());
  const next = nextExpiry(typing, now);
  useEffect(() => {
    if (next === null) return;
    const id = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => window.clearTimeout(id);
  }, [next]);
  const who = Object.entries(typing)
    .filter(([, until]) => until > now)
    .map(([uid]) => memberName(workspaceId, uid));
  return typingText(who);
}

/** The earliest expiry still in the future of `now`, or null when nobody types. */
export function nextExpiry(typing: Record<string, number>, now: number): number | null {
  let next: number | null = null;
  for (const until of Object.values(typing)) if (until > now && (next === null || until < next)) next = until;
  return next;
}

export function typingText(who: string[]): string {
  if (who.length === 1) return t('chat.typing1', { name: who[0] ?? '' });
  if (who.length === 2) return t('chat.typing2', { a: who[0] ?? '', b: who[1] ?? '' });
  if (who.length > 2) return plural('chat.typingN', who.length);
  return '';
}

/** Three pulsing dots (static under reduced motion / screenshot tests). */
export function TypingDots(): ReactNode {
  return (
    <span className="inline-flex gap-px" aria-hidden>
      <span className="typing-dot">•</span>
      <span className="typing-dot [animation-delay:.2s]">•</span>
      <span className="typing-dot [animation-delay:.4s]">•</span>
    </span>
  );
}
