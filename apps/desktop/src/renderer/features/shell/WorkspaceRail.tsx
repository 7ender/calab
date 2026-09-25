import { Compass, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { MediaImg } from '../../components/MediaImg';
import { Tip, cx } from '../../components/ui';
import { t } from '../../i18n';
import { thumbnailPath } from '../../lib/api/endpoints';
import { isUnread, useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { platform } from '../../platform';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

const tile =
  'relative grid size-10 place-items-center rounded-[var(--radius-panel)] text-[14px] font-semibold transition-colors duration-[var(--motion-fast)]';

/** Workspace rail, 64 px, sidebar material; macOS traffic lights sit above it (hiddenInset). */
export function WorkspaceRail(): ReactNode {
  const order = useWorkspaces((s) => s.order);
  const byId = useWorkspaces((s) => s.byId);
  const active = useUi((s) => s.activeWorkspaceId);
  const setWs = useUi((s) => s.setWorkspace);
  const open = useUi((s) => s.openDialog);
  const rooms = useRooms();
  const mac = useSession((s) => s.appInfo?.platform === 'darwin') && platform.kind === 'electron';

  return (
    <nav
      className={cx('mat-rail drag flex w-[var(--rail-width)] shrink-0 flex-col items-center gap-2 overflow-y-auto pb-3', mac ? 'pt-11' : 'pt-3')}
      aria-label={t('ws.list')}
    >
      {order.map((id) => {
        const w = byId[id]?.ws;
        if (!w) return null;
        const list = Object.values(rooms.byId).filter((r) => r.workspaceId === id);
        const unread = list.some((r) => isUnread(r.id, rooms));
        const mentions = list.reduce((n, r) => n + (rooms.mentions[r.id] ?? 0), 0);
        const isActive = id === active;
        return (
          <div key={id} className="relative flex w-full justify-center">
            <span
              aria-hidden
              className={cx(
                'absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full bg-fg transition-[height] duration-[var(--motion)]',
                isActive ? 'h-6' : unread ? 'h-2' : 'h-0',
              )}
            />
            <Tip label={w.name} side="right">
              <button
                type="button"
                onClick={() => setWs(id)}
                aria-current={isActive ? 'page' : undefined}
                aria-label={`${w.name}${unread ? `, ${t('ws.unread')}` : ''}`}
                className={cx(tile, isActive ? 'bg-accent-strong text-accent-fg' : 'bg-hover text-fg hover:bg-[var(--color-fill-hover)]')}
              >
                {w.iconFileId ? (
                  <MediaImg path={thumbnailPath(w.iconFileId)} alt="" className="size-full rounded-[inherit] object-cover" />
                ) : (
                  initials(w.name)
                )}
                {mentions > 0 ? (
                  <span className="absolute -bottom-1 -right-1 min-w-4 rounded-full bg-danger-fill px-1 text-center text-[11px] font-semibold leading-4 text-white">
                    {mentions > 99 ? '99+' : mentions}
                  </span>
                ) : null}
              </button>
            </Tip>
          </div>
        );
      })}
      {order.length ? <div className="my-0.5 h-px w-6 bg-line" aria-hidden /> : null}
      <Tip label={t('ws.create')} side="right">
        <button type="button" onClick={() => open({ kind: 'create-workspace' })} className={cx(tile, 'bg-hover text-muted hover:text-fg')} aria-label={t('ws.create')}>
          <Plus className="size-5" strokeWidth={1.75} />
        </button>
      </Tip>
      <Tip label={t('ws.join')} side="right">
        <button type="button" onClick={() => open({ kind: 'join-workspace' })} className={cx(tile, 'bg-hover text-muted hover:text-fg')} aria-label={t('ws.join')}>
          <Compass className="size-5" strokeWidth={1.75} />
        </button>
      </Tip>
    </nav>
  );
}
