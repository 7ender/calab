import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, roomPerms } from '../../lib/permissions';
import { openRoom, type OutgoingFile } from '../../services/chat';
import { subscribeRooms } from '../../services/gateway';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { MEMBERS_COLUMN_MIN, useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { StatsOverlay } from '../voice/StatsOverlay';
import { StreamArea } from '../voice/StreamArea';
import { useChatView } from './chatView';
import { Composer, toOutgoing } from './Composer';
import { MessageList } from './MessageList';
import { RoomHeader } from './RoomHeader';
import { PinnedBar, SearchPanel } from './RoomPanels';

export function ChatPane({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const wide = useMediaQuery(`(min-width: ${MEMBERS_COLUMN_MIN}px)`);
  const toggleColumn = useUi((s) => s.toggleMembers);
  const columnOpen = useUi((s) => s.membersPanel);
  const overlayOpen = useUi((s) => s.membersOverlay);
  const setOverlay = useUi((s) => s.setMembersOverlay);
  const membersOpen = wide ? columnOpen : overlayOpen;
  const toggleMembers = (): void => (wide ? toggleColumn() : setOverlay(!overlayOpen));
  const inThisVoice = useVoice((s) => s.roomId === roomId);
  const searchOpen = useChatView((s) => s.searchRoom === roomId);
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  // "New messages" marker: the read position at the moment the room was opened.
  const [newMarker] = useState(() => useRooms.getState().readState[roomId] ?? '');
  // PiP keeps clear of the composer: expose its height as --composer-height (docs/08, Layout).
  const sectionRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    // Set on the content column: the PiP (inside) and the floating members panel (sibling) use it.
    const host = sectionRef.current?.parentElement;
    if (!el || !host) return;
    const ro = new ResizeObserver(() => host.style.setProperty('--composer-height', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  });

  useEffect(() => {
    void openRoom(roomId);
    subscribeRooms([roomId]);
  }, [roomId]);

  // The search panel belongs to the room it was opened in; ⌘/Ctrl+F opens it here.
  useEffect(() => {
    const view = useChatView.getState();
    if (view.searchRoom && view.searchRoom !== roomId) view.setSearch(null);
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'f' && !useUi.getState().dialog) {
        e.preventDefault();
        useChatView.getState().setSearch(roomId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [roomId]);

  const perms = useMemo(() => roomPerms(role, me, room), [role, me, room]);
  const canAttach = can(perms, 'ATTACH_FILES');

  const addFiles = useCallback(
    (list: File[]) => {
      if (!canAttach) return;
      setFiles((cur) => [...cur, ...list.map(toOutgoing)].slice(0, 20));
    },
    [canAttach],
  );

  if (!room) return <div className="mat-content flex-1" />;

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <section
      ref={sectionRef}
      className="mat-content relative flex min-w-0 flex-1 flex-col"
      aria-label={room.name}
      onDragOver={(e) => {
        if (canAttach && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <RoomHeader workspaceId={workspaceId} room={room} perms={perms} membersOpen={membersOpen} toggleMembers={toggleMembers} />
      {searchOpen ? <SearchPanel roomId={roomId} /> : <PinnedBar workspaceId={workspaceId} roomId={roomId} />}

      {inThisVoice ? <StreamArea /> : null}
      {inThisVoice ? <StatsOverlay /> : null}

      <MessageList workspaceId={workspaceId} room={room} perms={perms} newMarker={newMarker} />
      <div ref={composerRef} data-testid="composer" className="shrink-0 bg-feed">
        <Composer workspaceId={workspaceId} room={room} perms={perms} files={files} setFiles={setFiles} addFiles={addFiles} />
      </div>

      {dragging ? (
        <div className={cx('mat-popover pointer-events-none absolute inset-3 z-[var(--z-popover)] grid place-items-center rounded-[var(--radius-panel)] border-2 border-dashed border-accent')}>
          <div className="text-center">
            <div className="text-[16px] font-semibold">{t('chat.dropHere')}</div>
            <div className="text-muted">#{room.name}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
