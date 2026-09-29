import type { RoomInvite } from '@calaba/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Badge, Card, Row, Segmented, Select, Toggle } from '../../components/ui';
import { t } from '../../i18n';
import { errorText } from '../../lib/api/errors';
import { api } from '../../lib/api/endpoints';
import { useRooms } from '../../stores/rooms';
import { toast } from '../../stores/toasts';
import { admissionApi } from './services/admissions';

/**
 * Guest admission settings (ADR-0040 §1): the room's «Вход гостей по ссылке» and a link's own
 * choice «Как у комнаты / Сразу / С подтверждением» (unset `require_approval` inherits the room).
 */

export type LinkApproval = 'inherit' | 'now' | 'approval';

export const linkApprovalOf = (i: Pick<RoomInvite, 'requireApproval'>): LinkApproval =>
  i.requireApproval === undefined ? 'inherit' : i.requireApproval ? 'approval' : 'now';

/** The create request's field: unset inherits. */
export const linkApprovalInit = (v: LinkApproval): { requireApproval?: boolean } => (v === 'inherit' ? {} : { requireApproval: v === 'approval' });

/** What a link does in effect: its own setting, else the room's. */
export const linkRequiresApproval = (i: Pick<RoomInvite, 'requireApproval'>, roomApproval: boolean): boolean => i.requireApproval ?? roomApproval;

const useRoomApproval = (roomId: string): boolean => useRooms((s) => s.byId[roomId]?.guestApproval ?? false);

/** Room settings → «Гости по ссылке»: «С подтверждением организатора» (MANAGE_ROOM, server-checked). Optimistic. */
export function RoomApprovalCard({ roomId }: { roomId: string }): ReactNode {
  const stored = useRoomApproval(roomId);
  const [pending, setPending] = useState<boolean | null>(null);
  const on = pending ?? stored;
  const set = async (v: boolean): Promise<void> => {
    setPending(v);
    try {
      const r = await api.rooms.update(roomId, { guestApproval: v });
      if (r.room) useRooms.getState().upsert(r.room);
    } catch (e) {
      toast.error(errorText(e, t('adm.saveFailed')));
    } finally {
      setPending(null);
    }
  };
  return (
    <Card title={t('adm.roomTitle')}>
      <Row label={t('adm.roomToggle')} hint={t('adm.roomHint')}>
        <Toggle label={t('adm.roomToggle')} checked={on} onChange={(v) => void set(v)} />
      </Row>
    </Card>
  );
}

/** The new link's choice, with what it means now (the room's setting shows through «Как у комнаты»). */
export function LinkApprovalRow({ roomId, value, onChange }: { roomId: string; value: LinkApproval; onChange: (v: LinkApproval) => void }): ReactNode {
  const room = useRoomApproval(roomId);
  const hint =
    value === 'inherit' ? (room ? t('adm.linkHintInheritApproval') : t('adm.linkHintInheritNow')) : value === 'approval' ? t('adm.linkHintApproval') : t('adm.linkHintNow');
  return (
    <Row label={t('adm.linkField')} hint={hint}>
      <Segmented
        label={t('adm.linkField')}
        value={value}
        onChange={onChange}
        options={[
          { value: 'inherit', label: t('adm.linkInherit') },
          { value: 'now', label: t('adm.linkNow') },
          { value: 'approval', label: t('adm.linkApproval') },
        ]}
      />
    </Row>
  );
}

/** «с подтверждением» on a link line when its guests wait (own setting or the room's). */
export function LinkApprovalTag({ roomId, invite }: { roomId: string; invite: RoomInvite }): ReactNode {
  const room = useRoomApproval(roomId);
  if (!linkRequiresApproval(invite, room)) return null;
  return (
    <Badge className="shrink-0" title={t('adm.linkHintApproval')}>
      {t('adm.linkTag')}
    </Badge>
  );
}

/** An active link's own choice (PATCH …/invites/{id}); «Как у комнаты» names the room's value. */
export function LinkApprovalSelect({ roomId, invite }: { roomId: string; invite: RoomInvite }): ReactNode {
  const room = useRoomApproval(roomId);
  const qc = useQueryClient();
  const [pending, setPending] = useState<LinkApproval | null>(null);
  const value = pending ?? linkApprovalOf(invite);
  const set = async (v: LinkApproval): Promise<void> => {
    setPending(v);
    try {
      await admissionApi.setLinkApproval(roomId, invite.id, v === 'inherit' ? null : v === 'approval');
      await qc.invalidateQueries({ queryKey: ['roomInvites', roomId] });
    } catch (e) {
      toast.error(errorText(e, t('adm.saveFailed')));
    } finally {
      setPending(null);
    }
  };
  return (
    <Select aria-label={t('adm.linkEdit', { code: invite.code })} className="w-44 shrink-0" value={value} onChange={(e) => void set(e.target.value as LinkApproval)}>
      <option value="inherit">{room ? t('adm.linkInheritApproval') : t('adm.linkInheritNow')}</option>
      <option value="now">{t('adm.linkNow')}</option>
      <option value="approval">{t('adm.linkApproval')}</option>
    </Select>
  );
}
