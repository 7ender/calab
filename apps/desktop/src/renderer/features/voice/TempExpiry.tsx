import { Timer } from 'lucide-react';
import { memo, useEffect, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, roomPerms } from '../../lib/permissions';
import { EXPIRING_MS, expiresMs, extendTo } from '../../lib/tempRooms';
import { extendTempRoom, warnTenMinutes } from '../../services/tempRooms';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useMemberRoles } from '../../stores/workspaces';
import { useNow } from '../shell/voiceFormat';

/**
 * The call island's line for a temporary room (ADR-0044): under 10 minutes left — «⏱ 9 мин» in the
 * attention colour and «Продлить» (+1 ч) for whoever may manage the room; «Осталось 10 минут» once
 * per room as a toast. A leaf with its own 30 s clock, only for a temporary room (a permanent one
 * subscribes to no clock at all); the island itself never re-renders for it.
 */
export const TempExpiry = memo(function TempExpiry({ roomId, workspaceId, compact = false, className }: { roomId: string; workspaceId: string | null; compact?: boolean; className?: string }): ReactNode {
  const expires = useRooms((s) => expiresMs(s.byId[roomId]));
  const name = useRooms((s) => s.byId[roomId]?.name ?? '');
  const me = useSession((s) => s.me?.user?.id ?? '');
  const roles = useMemberRoles(workspaceId, me);
  // MANAGE_ROOM in the room or its creator (lib/permissions mayManageRoom), as primitives.
  const manage = useRooms((s) => {
    const room = s.byId[roomId];
    return !!room && (room.createdBy === me || can(roomPerms(roles, me, room), 'MANAGE_ROOM'));
  });
  const now = useNow(expires ? 30_000 : 0);
  const left = expires - now;
  const soon = expires > 0 && left > 0 && left < EXPIRING_MS;
  useEffect(() => {
    if (soon) warnTenMinutes(roomId, name);
  }, [soon, roomId, name]);
  if (!soon) return null;
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return (
    <span className={cx('flex items-center gap-1.5 text-[12px] leading-4', className)} data-testid="temp-expiry">
      <Timer className="size-3.5 shrink-0 text-attention" aria-hidden />
      <span className="font-medium tabular-nums text-attention" aria-label={t('temp.left', { left: t('temp.islandMin', { n: minutes }) })}>
        {t('temp.islandMin', { n: minutes })}
      </span>
      {manage && !compact ? (
        <button
          type="button"
          className="rounded-[var(--radius-control)] font-medium text-accent-text hover:underline"
          onClick={() => void extendTempRoom(roomId, extendTo(expires, 3_600_000, Date.now()))}
          data-testid="temp-expiry-extend"
        >
          {t('temp.extend')}
        </button>
      ) : null}
    </span>
  );
});
