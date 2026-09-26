import { Compass, Plus } from 'lucide-react';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { isAdminRole } from '../../lib/permissions';
import { installAfk } from '../../services/afk';
import { installHotkeys } from '../../services/hotkeys';
import { defaultRoom, roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useDelayed } from '../../lib/useDelayed';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { MEMBERS_COLUMN_MIN, useUi } from '../../stores/ui';
import { useWorkspaces } from '../../stores/workspaces';
import { ChatPane } from '../chat/ChatPane';
import { Onboarding } from '../onboarding/Onboarding';
import { MembersPanel } from './MembersPanel';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';
import { WorkspaceRail } from './WorkspaceRail';

/**
 * Main layout (docs/08, «Layout»; docs/09 #1–#2):
 * title bar 38 px across the window, then
 * rail 72 px │ rooms 256 px (200–320, resizable) │ content (opaque) │ members (optional).
 */
export function AppShell(): ReactNode {
  const ready = useSession((s) => s.ready);
  const gateway = useSession((s) => s.gateway);
  const onboarded = usePrefs((s) => s.onboarded);
  const wsId = useUi((s) => s.activeWorkspaceId);
  const hasWs = useWorkspaces((s) => (wsId ? !!s.byId[wsId] : false));
  const roomId = useActiveRoom(wsId);
  // ≥ 1200 px: a column next to the chat; narrower: a floating panel over it (docs/08, Layout).
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  const columnOpen = useUi((s) => s.membersPanel);
  const overlayOpen = useUi((s) => s.membersOverlay);
  const width = useUi((s) => s.sidebarWidth);

  // Short reconnects (a server deploy re-IDENTIFYs in 1–5 s) don't flash the banner.
  const showReconnect = useDelayed(ready && gateway !== 'ready', 3000);

  useEffect(() => installHotkeys(), []);
  useEffect(() => installAfk(), []);

  if (!onboarded) return <Onboarding />;

  return (
    <div className="flex h-full flex-col" style={{ ['--sidebar-width' as string]: `${width}px` }}>
      <TitleBar />
      {showReconnect ? (
        <div role="status" className="z-[var(--z-sticky)] bg-warn px-3 py-1 text-center text-caption font-medium text-black">
          {t('gateway.reconnecting')}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <WorkspaceRail />
        {!ready ? (
          <div className="mat-content grid flex-1 place-items-center">
            <div className="flex flex-col items-center gap-3 text-body text-muted">
              <Spinner className="size-6" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : hasWs && wsId ? (
          <>
            <Sidebar workspaceId={wsId} />
            <ResizeHandle />
            <div className="mat-content relative flex min-w-0 flex-1">
              {roomId ? <ChatPane key={roomId} workspaceId={wsId} roomId={roomId} /> : <NoRoom workspaceId={wsId} />}
              {roomId && wide && columnOpen ? <MembersPanel workspaceId={wsId} /> : null}
              {roomId && !wide && overlayOpen ? <MembersPanel workspaceId={wsId} floating /> : null}
            </div>
          </>
        ) : (
          <Welcome />
        )}
      </div>
    </div>
  );
}

/**
 * The room shown for a workspace (docs/09 #11): the remembered one if it still exists, else the
 * first text room (remembered without adding a history step). Undefined only without rooms.
 */
function useActiveRoom(wsId: string | null): string | undefined {
  const remembered = useUi((s) => (wsId ? s.lastRoom[wsId] : undefined));
  const byId = useRooms((s) => s.byId);
  const categories = useRooms((s) => s.categories);
  const valid = !!remembered && byId[remembered]?.workspaceId === wsId;
  const fallback = useMemo(() => {
    if (!wsId || valid) return undefined;
    return defaultRoom(
      roomsOfWorkspace(byId, wsId),
      Object.values(categories).filter((c) => c.workspaceId === wsId),
    )?.id;
  }, [wsId, valid, byId, categories]);
  useEffect(() => {
    if (wsId && fallback) useUi.getState().selectDefaultRoom(wsId, fallback);
  }, [wsId, fallback]);
  return valid ? remembered : fallback;
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

/** Only for a workspace without any rooms (otherwise a room is always open, docs/09 #11). */
function NoRoom({ workspaceId }: { workspaceId: string }): ReactNode {
  const open = useUi((s) => s.openDialog);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-body text-muted">
      <MessagesSquare className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
      <p>{isAdminRole(role) ? t('shell.noRooms') : t('shell.noRoomsMember')}</p>
      {isAdminRole(role) ? (
        <Button onClick={() => open({ kind: 'room-create', workspaceId, voice: false })}>{t('shell.createFirstRoom')}</Button>
      ) : null}
    </div>
  );
}

function Welcome(): ReactNode {
  const open = useUi((s) => s.openDialog);
  // The create / join dialogs cover this block; hide it meanwhile so its accent button never
  // peeks out beside the (narrower) dialog.
  const covered = useUi((s) => s.dialog !== null);
  return (
    <div className="mat-content grid flex-1 place-items-center">
      <div className={cx('flex max-w-sm flex-col items-center gap-2 text-center', covered && 'invisible')}>
        <h1 className="text-title font-semibold">{t('shell.welcome')}</h1>
        <p className="text-body text-muted">{t('shell.welcomeText')}</p>
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
