import { RoomType } from '@calaba/protocol';
import { useQuery } from '@tanstack/react-query';
import { Hash, Volume2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { joinRoomLink, roomLinkError } from './roomLink';

/** A pasted room link (`…/r/<code>`) in «Присоединиться»: preview + «Войти в комнату». */
export function RoomLinkPreview({ code, onDone }: { code: string; onDone: () => void }): ReactNode {
  const q = useQuery({ queryKey: ['roomLink', code], queryFn: () => api.roomInvites.get(code), retry: false });
  const [busy, setBusy] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <p className="text-caption text-danger-text">{roomLinkError(q.error)}</p>;
  const voice = q.data.roomType === RoomType.VOICE;
  return (
    <div className="flex items-center gap-3 rounded-[var(--radius-control)] bg-side px-3 py-2">
      {voice ? <Volume2 className="size-4 shrink-0 text-muted" aria-hidden /> : <Hash className="size-4 shrink-0 text-muted" aria-hidden />}
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold" title={q.data.roomName}>
          {q.data.roomName}
        </div>
        <div className="truncate text-caption text-muted">{q.data.workspaceName}</div>
      </div>
      <Button
        busy={busy}
        onClick={() => {
          setBusy(true);
          void joinRoomLink(code).then((ok) => {
            setBusy(false);
            if (ok) onDone();
          });
        }}
      >
        {t('people.link.open')}
      </Button>
    </div>
  );
}
