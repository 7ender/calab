import { Compass, Plus } from 'lucide-react';
import { MessagesSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button, Spinner, cx } from '../../components/ui';
import { t } from '../../i18n';
import { mayArrangeRooms } from '../../lib/permissions';
import { installAfk } from '../../services/afk';
import { installPresenceTimer } from '../../services/presenceTimer';
import { installHotkeys } from '../../services/hotkeys';
import { installEmail } from '../../services/email';
import { VerifyBanner } from '../auth/VerifyEmail';
import { SuspendedBanner } from '../workspace/SuspendedBanner';
import { defaultRoom, roomsOfWorkspace, useRooms } from '../../stores/rooms';
import { usePrefs } from '../../stores/prefs';
import { useSession } from '../../stores/session';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { useMobile } from '../../lib/mobile';
import { MobileShell } from './MobileShell';
import { MEMBERS_COLUMN_MIN, useUi } from '../../stores/ui';
import { useMemberRoles, useWorkspaces } from '../../stores/workspaces';
import { ChatPane } from '../chat/ChatPane';
import { DmPick, useActiveDm } from '../dm/DmHome';
import { DmSidebar } from '../dm/DmSidebar';
import { HOME } from '../../stores/dms';
import { Onboarding } from '../onboarding/Onboarding';
import { MembersPanel } from './MembersPanel';
import { BottomIsland } from './BottomIsland';
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
  const onboarded = usePrefs((s) => s.onboarded);
  const wsId = useUi((s) => s.activeWorkspaceId);
  const home = wsId === HOME;
  const hasWs = useWorkspaces((s) => (wsId && !home ? !!s.byId[wsId] : false));
  const roomId = useActiveRoom(home ? null : wsId);
  const dmId = useActiveDm();
  // ≥ 1200 px: a column next to the chat; narrower: a floating panel over it (docs/08, Layout).
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  const columnOpen = useUi((s) => s.membersPanel);
  const overlayOpen = useUi((s) => s.membersOverlay);
  const width = useUi((s) => s.sidebarWidth);

  // Short reconnects (a server deploy re-IDENTIFYs in 1–5 s) don't flash the banner; it goes
  // away the moment READY/RESUMED arrives (lib/gateway/banner.ts).
  const showReconnect = useSession((s) => s.ready && s.reconnectBanner);

  const mobile = useMobile();

  useEffect(() => installHotkeys(), []);
  useEffect(() => installAfk(), []);
  useEffect(() => installPresenceTimer(), []);
  useEffect(() => installEmail(), []);

  if (!onboarded) return <Onboarding />;
  if (mobile) {
    // Phone layout (ADR-0021): one column — the chat full screen, the rail + rooms and the members
    // list in drawers, the voice strip at the bottom.
    // «Личные» (ADR-0020): the DM list in the drawer, the open DM full screen.
    const ws = home ? HOME : hasWs && wsId ? wsId : null;
    return (
      <MobileShell workspaceId={ws} roomId={home ? dmId : ws ? roomId : undefined} showReconnect={showReconnect}>
        {!ready ? (
          <div className="grid flex-1 place-items-center">
            <div className="flex flex-col items-center gap-3 text-body text-muted">
              <Spinner className="size-6" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : home ? (
          dmId ? (
            <ChatPane key={dmId} workspaceId="" roomId={dmId} />
          ) : (
            <DmPick />
          )
        ) : ws ? (
          roomId ? (
            <ChatPane key={roomId} workspaceId={ws} roomId={roomId} />
          ) : (
            <NoRoom workspaceId={ws} />
          )
        ) : (
          <Welcome />
        )}
      </MobileShell>
    );
  }

  return (
    <div className="flex h-full flex-col" style={{ ['--sidebar-width' as string]: `${width}px` }}>
      <TitleBar />
      {/* ADR-0023: «Подтвердите почту» over the main content until the code is entered. */}
      <VerifyBanner />
      <SuspendedBanner />
      {showReconnect ? (
        <div role="status" className="z-[var(--z-sticky)] bg-warn px-3 py-1 text-center text-caption font-medium text-black">
          {t('gateway.reconnecting')}
        </div>
      ) : null}
      {/* The rail sits on the window layer (same material as the title bar); the room column and
          the chat are one «island» with a 12 px top-left corner and a hairline edge (docs/09 v0.2). */}
      <div className="mat-rail relative flex min-h-0 flex-1">
        <WorkspaceRail />
        {!ready ? (
          <div className="mat-content grid flex-1 place-items-center mobile:px-6">
            <div className="flex flex-col items-center gap-3 text-body text-muted">
              <Spinner className="size-6" />
              {t('gateway.connecting')}
            </div>
          </div>
        ) : home ? (
          // «Личные» (ADR-0020): the DM list in the room column, the DM chat without members/voice.
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-line" data-testid="main-island">
            <DmSidebar />
            <ResizeHandle />
            <div className="mat-content relative flex min-w-0 flex-1">
              {dmId ? <ChatPane key={dmId} workspaceId="" roomId={dmId} /> : <DmPick />}
            </div>
          </div>
        ) : hasWs && wsId ? (
          <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-line" data-testid="main-island">
            <Sidebar workspaceId={wsId} />
            <ResizeHandle />
            <div className="mat-content relative flex min-w-0 flex-1">
              {roomId ? <ChatPane key={roomId} workspaceId={wsId} roomId={roomId} /> : <NoRoom workspaceId={wsId} />}
              {roomId && wide && columnOpen ? <MembersPanel workspaceId={wsId} /> : null}
              {roomId && !wide && overlayOpen ? <MembersPanel workspaceId={wsId} floating /> : null}
            </div>
          </div>
        ) : (
          <Welcome />
        )}
        {ready && (home || (hasWs && wsId)) ? <BottomIsland /> : null}
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
  const me = useSession((s) => s.me?.user?.id ?? '');
  const manage = mayArrangeRooms(useMemberRoles(workspaceId, me));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-body text-muted">
      <MessagesSquare className="size-10 text-muted" strokeWidth={1.25} aria-hidden />
      <p>{manage ? t('shell.noRooms') : t('shell.noRoomsMember')}</p>
      {manage ? (
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
    <div className="mat-content grid flex-1 place-items-center mobile:px-6">
      <div className={cx('flex max-w-sm flex-col items-center gap-2 text-center', covered && 'invisible')}>
        <h1 className="text-title font-semibold">{t('shell.welcome')}</h1>
        <p className="text-body text-muted">{t('shell.welcomeText')}</p>
        {/* Phones: the two actions stacked full width, the primary one on top. */}
        <div className="mt-4 flex gap-2 mobile:w-full mobile:flex-col-reverse">
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
