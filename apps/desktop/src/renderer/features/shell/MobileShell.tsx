import * as DialogP from '@radix-ui/react-dialog';
import { Menu } from 'lucide-react';
import { useRef, type ReactNode, type TouchEvent } from 'react';
import { IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { useSession } from '../../stores/session';
import { HOME } from '../../stores/dms';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { DmSidebar } from '../dm/DmSidebar';
import { BottomIsland } from './BottomIsland';
import { MembersPanel } from './MembersPanel';
import { MobileVoiceStrip } from './MobileVoiceStrip';
import { Sidebar } from './Sidebar';
import { WorkspaceRail } from './WorkspaceRail';
import { VerifyBanner } from '../auth/VerifyEmail';
import { SuspendedBanner } from '../workspace/SuspendedBanner';

/** A horizontal swipe longer than this (and mostly horizontal) opens / closes a drawer. */
const SWIPE_PX = 56;
/** An opening swipe starts this close to the left edge. */
const EDGE_PX = 28;

/**
 * Phone layout of the web client (ADR-0021, stage A; ≤ 768 px, lib/mobile.ts). `workspaceId` may be
 * HOME («Личные», ADR-0020): the drawer holds the DM list, a DM has no members drawer.
 *  - one column: the room (its header is the top bar, with ☰) full screen, above the keyboard
 *    (the shell is `--app-height` = the visual viewport tall, lib/mobile.ts);
 *  - the rail + room column + the desktop bottom island (full voice panel, self panel) are a
 *    drawer from the left: ☰ or an edge swipe opens it, a swipe back / the scrim / Esc / picking a
 *    room closes it;
 *  - the members list is a drawer from the right (the header's «Участники»);
 *  - in voice, the compact voice strip sits at the bottom (MobileVoiceStrip).
 * iOS safe areas: the top inset on the shell, the bottom one on whatever is last (strip or composer).
 */
export function MobileShell({
  workspaceId,
  roomId,
  showReconnect,
  children,
}: {
  workspaceId: string | null;
  roomId: string | undefined;
  showReconnect: boolean;
  children: ReactNode;
}): ReactNode {
  const ready = useSession((s) => s.ready);
  const inVoice = useVoice((s) => s.roomId !== null);
  const drawer = useUi((s) => s.navDrawer);
  const setDrawer = useUi((s) => s.setNavDrawer);
  const members = useUi((s) => s.membersOverlay);
  const setMembers = useUi((s) => s.setMembersOverlay);
  const strip = ready && !!workspaceId && inVoice;
  const chat = ready && !!workspaceId && !!roomId;
  const swipe = useSwipe((dir, fromEdge) => {
    if (dir === 'right' && fromEdge) setDrawer(true);
  });

  return (
    <div
      className="mat-rail relative flex h-full flex-col overflow-hidden pl-[var(--safe-left)] pr-[var(--safe-right)] pt-[var(--safe-top)]"
      data-layout="mobile"
      data-testid="mobile-shell"
      // The composer carries the bottom safe-area inset unless the voice strip is below it.
      style={{ ['--composer-safe' as string]: strip ? '0px' : 'var(--safe-bottom, 0px)' }}
      {...swipe}
    >
      {showReconnect ? (
        <div role="status" className="z-[var(--z-sticky)] bg-warn px-3 py-1 text-center text-caption font-medium text-black">
          {t('gateway.reconnecting')}
        </div>
      ) : null}
      <VerifyBanner />
      <SuspendedBanner />
      <main className="mat-content relative flex min-h-0 flex-1 flex-col">
        {chat ? null : <MobileTopBar workspaceId={workspaceId} />}
        {children}
      </main>
      {strip ? <MobileVoiceStrip /> : null}

      {ready && workspaceId ? <NavDrawer workspaceId={workspaceId} open={drawer} onOpenChange={setDrawer} /> : null}
      {chat && workspaceId && workspaceId !== HOME ? <MembersDrawer workspaceId={workspaceId} open={members} onOpenChange={setMembers} /> : null}
    </div>
  );
}

/** Top bar without a room (connecting, welcome, empty workspace): ☰ + the workspace name. */
function MobileTopBar({ workspaceId }: { workspaceId: string | null }): ReactNode {
  const name = useWorkspaces((s) => (workspaceId === HOME ? t('dm.home') : workspaceId ? s.byId[workspaceId]?.ws.name : undefined));
  return (
    <header className="mat-toolbar flex h-12 shrink-0 items-center gap-2 border-b border-line px-2">
      {workspaceId ? <NavButton /> : <span className="w-2" />}
      <h1 className="min-w-0 truncate text-list font-semibold">{name ?? 'Calab'}</h1>
    </header>
  );
}

/** ☰ — opens the rail + room column drawer (the room header and the top bar). */
export function NavButton(): ReactNode {
  const setDrawer = useUi((s) => s.setNavDrawer);
  const open = useUi((s) => s.navDrawer);
  return (
    <IconButton tip={false} label={t('mobile.openNav')} aria-expanded={open} onClick={() => setDrawer(true)} className="size-10 shrink-0 rounded-full">
      <Menu className="size-5" />
    </IconButton>
  );
}

/** Left drawer: the desktop rail + room column + bottom island, at phone width. */
function NavDrawer({ workspaceId, open, onOpenChange }: { workspaceId: string; open: boolean; onOpenChange: (o: boolean) => void }): ReactNode {
  const swipe = useSwipe((dir) => {
    if (dir === 'left') onOpenChange(false);
  });
  return (
    <DialogP.Root open={open} onOpenChange={onOpenChange}>
      <DialogP.Portal>
        <DialogP.Overlay className="anim-fade fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="mobile-nav"
          onOpenAutoFocus={(e) => {
            // Focus the panel itself: no focus ring on the first workspace after a tap.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          className="mat-rail anim-drawer-left fixed inset-y-0 left-0 z-[var(--z-modal)] flex w-[var(--mobile-drawer-width)] flex-col pb-[var(--safe-bottom)] pl-[var(--safe-left)] pt-[var(--safe-top)] shadow-[var(--shadow-popover)] focus:outline-none"
          style={{ ['--sidebar-width' as string]: 'calc(var(--mobile-drawer-width) - var(--rail-width))' }}
          {...swipe}
        >
          <DialogP.Title className="sr-only">{t('mobile.openNav')}</DialogP.Title>
          {/* The bottom island measures itself onto this box (--island-height): rail and rooms end above it. */}
          <div className="relative flex min-h-0 flex-1">
            <WorkspaceRail />
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-[var(--radius-panel)] border-l border-t border-line">
              {workspaceId === HOME ? <DmSidebar /> : <Sidebar workspaceId={workspaceId} />}
            </div>
            <BottomIsland />
          </div>
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

/** Right drawer: the members list. */
function MembersDrawer({ workspaceId, open, onOpenChange }: { workspaceId: string; open: boolean; onOpenChange: (o: boolean) => void }): ReactNode {
  const swipe = useSwipe((dir) => {
    if (dir === 'right') onOpenChange(false);
  });
  return (
    <DialogP.Root open={open} onOpenChange={onOpenChange}>
      <DialogP.Portal>
        <DialogP.Overlay className="anim-fade fixed inset-0 z-[var(--z-modal)] bg-scrim" />
        <DialogP.Content
          aria-modal="true"
          aria-describedby={undefined}
          data-testid="mobile-members"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          className="mat-sidebar anim-drawer-right fixed inset-y-0 right-0 z-[var(--z-modal)] flex w-[min(300px,calc(100vw-64px))] flex-col pr-[var(--safe-right)] pt-[var(--safe-top)] shadow-[var(--shadow-popover)] focus:outline-none"
          {...swipe}
        >
          <DialogP.Title className="sr-only">{t('shell.members')}</DialogP.Title>
          <MembersPanel workspaceId={workspaceId} drawer />
        </DialogP.Content>
      </DialogP.Portal>
    </DialogP.Root>
  );
}

type SwipeDir = 'left' | 'right';

/** Touch handlers reporting one horizontal swipe per gesture (vertical scrolling wins ties). */
function useSwipe(on: (dir: SwipeDir, fromEdge: boolean) => void): {
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: () => void;
} {
  const start = useRef<{ x: number; y: number; edge: boolean; done: boolean } | null>(null);
  return {
    onTouchStart: (e) => {
      const p = e.touches[0];
      if (!p || e.touches.length > 1) {
        start.current = null;
        return;
      }
      start.current = { x: p.clientX, y: p.clientY, edge: p.clientX <= EDGE_PX, done: false };
    },
    onTouchMove: (e) => {
      const s = start.current;
      const p = e.touches[0];
      if (!s || s.done || !p) return;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) {
        start.current = null; // a scroll, not a swipe
        return;
      }
      if (Math.abs(dx) < SWIPE_PX) return;
      s.done = true;
      on(dx > 0 ? 'right' : 'left', s.edge);
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}
