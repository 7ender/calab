import { useEffect, useState, type ReactNode } from 'react';
import { plural, t } from '../../i18n';
import { useTyping } from '../../stores/typing';
import { memberName } from '../../stores/workspaces';

const NONE: Record<string, number> = {};

/** «Bob печатает…» for the room header (Telegram shows it instead of the subtitle); '' when nobody types. */
export function useTypingText(workspaceId: string, roomId: string): string {
  const typing = useTyping((s) => s.rooms[roomId] ?? NONE);
  // Expired entries are removed by the dispatcher; the tick only re-filters between events.
  const [now, setNow] = useState(() => Date.now());
  const active = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  const who = Object.entries(typing)
    .filter(([, until]) => until > now)
    .map(([uid]) => memberName(workspaceId, uid));
  return typingText(who);
}

export function typingText(who: string[]): string {
  if (who.length === 1) return t('chat.typing1', { name: who[0] ?? '' });
  if (who.length === 2) return t('chat.typing2', { a: who[0] ?? '', b: who[1] ?? '' });
  if (who.length > 2) return t('chat.typingN', { n: who.length, people: plural(who.length, ['человек', 'человека', 'человек']) });
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
