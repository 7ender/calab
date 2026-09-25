import { Compass, Plus } from 'lucide-react';
import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { isAdminRole } from '../../lib/permissions';
import { installHotkeys } from '../../services/hotkeys';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { ChatPane } from '../chat/ChatPane';
import { Onboarding } from '../onboarding/Onboarding';
import { MembersPanel } from './MembersPanel';
import { Sidebar } from './Sidebar';
import { WorkspaceRail } from './WorkspaceRail';

/**
 * Main layout (docs/08, «Layout»):
 * rail 64 px │ rooms 240 px (200–320, resizable) │ content (opaque) │ members (optional).
 */
export function AppShell(): ReactNode {
  const ready = useSession((s) => s.ready);
  const gateway = useSession((s) => s.gateway);
  const onboarded = usePrefs((s) => s.onboarded);
  const wsId = useUi((s) => s.activeWorkspaceId);
  const hasWs = useWorkspaces((s) => (wsId ? !!s.byId[wsId] : false));
  const roomId = useUi((s) => (wsId ? s.lastRoom[wsId] : undefined));
  const membersOpen = useUi((s) => s.membersPanel);
  const width = useUi((s) => s.sidebarWidth);

  useEffect(() => installHotkeys(), []);

  if (!onboarded) return <Onboarding />;

  return (
    <div className="flex h-full flex-col" style={{ ['--sidebar-width' as string]: `${width}px` }}>
      {ready && gateway !== 'ready' ? (
        <div role="status" className="z-[var(--z-sticky)] bg-warn px-3 py-1 text-center text-[12px] font-medium text-black">
          {t('gateway.reconnecting')}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        {!ready ? (
          <div className="mat-content drag grid flex-1 place-items-center">
            <div className="flex flex-col items-center gap-3 text-[13px] text-muted">
              <Spinner className="size-6" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : hasWs && wsId ? (
          <>
            <Sidebar workspaceId={wsId} />
            <ResizeHandle />
            <div className="mat-content flex min-w-0 flex-1">
              {roomId ? <ChatPane key={roomId} workspaceId={wsId} roomId={roomId} /> : <NoRoom workspaceId={wsId} />}
              {membersOpen && roomId ? <MembersPanel workspaceId={wsId} /> : null}
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </div>
    </div>
  );
}

/** Drag the right edge of the room column (200–320 px). */
function ResizeHandle(): ReactNode {
  const setWidth = useUi((s) => s.setSidebarWidth);
  const start = useRef<{ x: number; w: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    start.current = { x: e.clientX, w: useUi.getState().sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (start.current) setWidth(start.current.w + e.clientX - start.current.x);
  };
  const onUp = (): void => {
    start.current = null;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('shell.resize')}
      aria-valuemin={200}
      aria-valuemax={320}
      aria-valuenow={useUi.getState().sidebarWidth}
      tabIndex={0}
      onKeyDown={(e) => {
        const w = useUi.getState().sidebarWidth;
        if (e.key === 'ArrowLeft') setWidth(w - 8);
        if (e.key === 'ArrowRight') setWidth(w + 8);
      }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      className="relative z-[var(--z-sticky)] -ml-[3px] w-[6px] shrink-0 cursor-col-resize after:absolute after:inset-y-0 after:left-[2.5px] after:w-px after:bg-line hover:after:bg-accent focus-visible:after:bg-accent"
    />
  );
}

function NoRoom({ workspaceId }: { workspaceId: string }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  return (
    <div className="drag flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-muted">
      <p>{t('shell.pickRoom')}</p>
      {isAdminRole(role) ? (
        <Button onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>{t('shell.createFirstRoom')}</Button>
      ) : null}
    </div>
  );
}

function Welcome(): ReactNode {
  const open = useUi((s) => s.openDialog);
  return (
    <div className="mat-content drag grid flex-1 place-items-center">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <h1 className="text-[20px] font-semibold">{t('shell.welcome')}</h1>
        <p className="text-[13px] text-muted">{t('shell.welcomeText')}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => open({ kind: 'join-workspace' })}>
            <Compass className="size-4" strokeWidth={1.75} />
            {t('ws.join')}
          </Button>
          <Button onClick={() => open({ kind: 'create-workspace' })}>
            <Plus className="size-4" strokeWidth={1.75} />
            {t('ws.create')}
          </Button>
        </div>
      </div>
    </div>
  );
}
