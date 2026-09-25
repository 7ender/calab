import { RoomType } from '@calaba/protocol';
import { Hash, Settings, Users, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { IconButton, cx } from '../../components/ui';
import { t } from '../../i18n';
import { can, roomPerms } from '../../lib/permissions';
import { openRoom, type OutgoingFile } from '../../services/chat';
import { subscribeRooms } from '../../services/gateway';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { useVoice } from '../../stores/voice';
import { useWorkspaces } from '../../stores/workspaces';
import { StreamArea } from '../voice/StreamArea';
import { Composer, toOutgoing } from './Composer';
import { MessageList } from './MessageList';
import { TypingIndicator } from './TypingIndicator';

export function ChatPane({ workspaceId, roomId }: { workspaceId: string; roomId: string }): ReactNode {
  const room = useRooms((s) => s.byId[roomId]);
  const role = useWorkspaces((s) => s.byId[workspaceId]?.role);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const toggleMembers = useUi((s) => s.toggleMembers);
  const membersOpen = useUi((s) => s.membersPanel);
  const openDialog = useUi((s) => s.openDialog);
  const inThisVoice = useVoice((s) => s.roomId === roomId);
  const [files, setFiles] = useState<OutgoingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  // "New messages" marker: the read position at the moment the room was opened.
  const [newMarker] = useState(() => useRooms.getState().readState[roomId] ?? '');

  useEffect(() => {
    void openRoom(roomId);
    subscribeRooms([roomId]);
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

  if (!room) return <div className="flex-1 bg-main" />;
  const voiceRoom = room.type === RoomType.VOICE;

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col bg-main"
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
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-rail px-4 pt-1 shadow-sm">
        {voiceRoom ? <Volume2 className="size-5 text-faint" /> : <Hash className="size-5 text-faint" />}
        <h2 className="no-drag font-semibold">{room.name}</h2>
        {room.topic ? <span className="no-drag ml-2 truncate border-l border-line pl-3 text-[13px] text-muted">{room.topic}</span> : null}
        <div className="flex-1" />
        {can(perms, 'MANAGE_ROOM') ? (
          <IconButton className="no-drag" label={t('room.settings')} onClick={() => openDialog({ kind: 'room-settings', roomId })}>
            <Settings className="size-[18px]" />
          </IconButton>
        ) : null}
        <IconButton className="no-drag" label={t('shell.members')} active={membersOpen} onClick={toggleMembers}>
          <Users className="size-[18px]" />
        </IconButton>
      </header>

      {inThisVoice ? <StreamArea /> : null}

      <MessageList workspaceId={workspaceId} roomId={roomId} perms={perms} newMarker={newMarker} />
      <Composer
        workspaceId={workspaceId}
        room={room}
        perms={perms}
        files={files}
        setFiles={setFiles}
        addFiles={addFiles}
      />
      <TypingIndicator workspaceId={workspaceId} roomId={roomId} />

      {dragging ? (
        <div className={cx('pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-main/85')}>
          <div className="text-center">
            <div className="text-lg font-semibold">{t('chat.dropHere')}</div>
            <div className="text-muted">#{room.name}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
