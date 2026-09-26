import { useState, type ReactNode } from 'react';
import { Card, Input, Row } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { parseUserLimit } from './voiceFormat';

/** Voice room settings → «Максимум участников» (docs/09 #31): 0 = unlimited, 1–99. */
export function UserLimitCard({ roomId }: { roomId: string }): ReactNode {
  const limit = useRooms((s) => s.byId[roomId]?.userLimit ?? 0);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(limit);
  const invalid = parseUserLimit(value) === null;
  const commit = async (): Promise<void> => {
    const n = parseUserLimit(value);
    setDraft(null);
    if (n === null || n === limit) return;
    try {
      const r = await api.rooms.update(roomId, { userLimit: n });
      if (r.room) useRooms.getState().upsert(r.room);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Card footer={t('shell.userLimitHint')}>
      <Row label={t('shell.userLimitLabel')} htmlFor={`user-limit-${roomId}`}>
        <Input
          id={`user-limit-${roomId}`}
          inputMode="numeric"
          className="w-20 text-right tabular-nums"
          aria-invalid={invalid || undefined}
          value={value}
          maxLength={2}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape' && draft !== null) {
              e.preventDefault();
              e.stopPropagation();
              setDraft(null);
            }
          }}
        />
      </Row>
    </Card>
  );
}
