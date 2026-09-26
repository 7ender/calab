import type { ReactNode } from 'react';
import { Card, Row, Stepper } from '../../components/ui';
import { t } from '../../i18n';
import { api } from '../../lib/api/endpoints';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';

/** Voice room settings → «Максимум участников» (docs/09 #31): 0 = unlimited (∞), 1–99; a stepper. */
export function UserLimitCard({ roomId }: { roomId: string }): ReactNode {
  const limit = useRooms((s) => s.byId[roomId]?.userLimit ?? 0);
  const commit = async (n: number): Promise<void> => {
    try {
      const r = await api.rooms.update(roomId, { userLimit: n });
      if (r.room) useRooms.getState().upsert(r.room);
    } catch (e) {
      toast.fail(e, t('err.ctx.save'));
    }
  };
  return (
    <Card title={t('card.limits')} footer={t('shell.userLimitHint')}>
      <Row label={t('shell.userLimitLabel')} htmlFor={`user-limit-${roomId}`}>
        <Stepper
          id={`user-limit-${roomId}`}
          label={t('shell.userLimitLabel')}
          value={limit}
          min={0}
          max={99}
          format={(v) => (v === 0 ? '∞' : String(v))}
          onCommit={(n) => void commit(n)}
        />
      </Row>
    </Card>
  );
}
