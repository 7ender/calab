import { useEffect, useState, type ReactNode } from 'react';
import { plural } from '../../i18n';
import { useMessages } from '../../stores/messages';
import { memberName } from '../../stores/workspaces';

const NONE: Record<string, number> = {};

export function TypingIndicator({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const typing = useMessages((s) => s.typing[roomId] ?? NONE);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const who = Object.entries(typing)
    .filter(([, until]) => until > now)
    .map(([uid]) => memberName(workspaceId, uid));
  let text = '';
  if (who.length === 1) text = `${who[0] ?? ''} печатает…`;
  else if (who.length === 2) text = `${who[0] ?? ''} и ${who[1] ?? ''} печатают…`;
  else if (who.length > 2) text = `${who.length} ${plural(who.length, ['человек', 'человека', 'человек'])} печатают…`;
  return (
    <div className="h-6 truncate px-5 pt-1 text-[12px] text-muted" aria-live="polite">
      {text ? (
        <span>
          <span className="typing-dot">•</span>
          <span className="typing-dot [animation-delay:.2s]">•</span>
          <span className="typing-dot [animation-delay:.4s]">•</span> {text}
        </span>
      ) : null}
    </div>
  );
}
