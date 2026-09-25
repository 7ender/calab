import { Compass, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Tip, cx } from '../../components/ui';
import { thumbnailUrl } from '../../lib/api/endpoints';
import { t } from '../../i18n';
import { isUnread, useRooms } from '../../stores/rooms';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function WorkspaceRail(): ReactNode {
  const order = useWorkspaces((s) => s.order);
  const byId = useWorkspaces((s) => s.byId);
  const active = useUi((s) => s.activeWorkspaceId);
  const setWs = useUi((s) => s.setWorkspace);
  const open = useUi((s) => s.openDialog);
  const rooms = useRooms();

  return (
    <nav className="drag flex w-[68px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail pb-3 pt-10" aria-label={t('ws.list')}>
      {order.map((id) => {
        const w = byId[id]?.ws;
        if (!w) return null;
        const roomIds = Object.values(rooms.byId).filter((r) => r.workspaceId === id);
        const unread = roomIds.some((r) => isUnread(r.id, rooms));
        const mentions = roomIds.reduce((n, r) => n + (rooms.mentions[r.id] ?? 0), 0);
        const isActive = id === active;
        return (
          <div key={id} className="no-drag relative flex w-full justify-center">
            <span
              className={cx(
                'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r bg-fg transition-all',
                isActive ? 'h-9' : unread ? 'h-2' : 'h-0',
              )}
            />
            <Tip label={w.name} side="right">
              <button
                type="button"
                onClick={() => setWs(id)}
                className={cx(
                  'relative grid size-12 place-items-center overflow-visible text-[15px] font-semibold transition-all',
                  isActive ? 'rounded-2xl bg-accent text-accent-fg' : 'rounded-3xl bg-main text-fg hover:rounded-2xl hover:bg-accent hover:text-accent-fg',
                )}
              >
                {w.iconFileId ? <img src={thumbnailUrl(w.iconFileId)} alt="" className="size-full rounded-[inherit] object-cover" /> : initials(w.name)}
                {mentions > 0 ? (
                  <span className="absolute -bottom-0.5 -right-0.5 min-w-5 rounded-full border-[3px] border-rail bg-danger px-1 text-center text-[11px] font-bold leading-4 text-white">
                    {mentions > 99 ? '99+' : mentions}
                  </span>
                ) : null}
              </button>
            </Tip>
          </div>
        );
      })}
      <div className="no-drag my-1 h-px w-8 bg-line" />
      <Tip label={t('ws.create')} side="right">
        <button type="button" onClick={() => open({ kind: 'create-workspace' })} className="no-drag grid size-12 place-items-center rounded-3xl bg-main text-ok transition-all hover:rounded-2xl hover:bg-ok hover:text-white" aria-label={t('ws.create')}>
          <Plus className="size-5" />
        </button>
      </Tip>
      <Tip label={t('ws.join')} side="right">
        <button type="button" onClick={() => open({ kind: 'join-workspace' })} className="no-drag grid size-12 place-items-center rounded-3xl bg-main text-ok transition-all hover:rounded-2xl hover:bg-ok hover:text-white" aria-label={t('ws.join')}>
          <Compass className="size-5" />
        </button>
      </Tip>
    </nav>
  );
}
