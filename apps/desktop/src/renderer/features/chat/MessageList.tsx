import type { PermissionBits } from '@calaba/protocol';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Spinner } from '../../components/ui';
import { t } from '../../i18n';
import { toDate } from '../../lib/format';
import { loadOlder, markRead } from '../../services/chat';
import { EMPTY_ROOM_MESSAGES, useMessages, type ChatMessage } from '../../stores/messages';
import { useRooms } from '../../stores/rooms';
import { useSession } from '../../stores/session';
import { MessageRow } from './MessageRow';

const START_INDEX = 1_000_000;
const GROUP_MS = 7 * 60 * 1000;

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export interface RowMeta {
  grouped: boolean;
  dayDivider: boolean;
  newDivider: boolean;
}

export function rowMeta(c: ChatMessage, prev: ChatMessage | undefined, newMarker: string, me: string): RowMeta {
  const d = toDate(c.msg.createdAt);
  const pd = prev ? toDate(prev.msg.createdAt) : undefined;
  const dayDivider = !pd || !sameDay(d, pd);
  const newDivider =
    !!newMarker && c.status === 'sent' && c.msg.id > newMarker && c.msg.authorId !== me && (!prev || prev.status !== 'sent' || prev.msg.id <= newMarker);
  const grouped =
    !!prev &&
    !dayDivider &&
    !newDivider &&
    prev.msg.authorId === c.msg.authorId &&
    !c.msg.replyToId &&
    d.getTime() - pd.getTime() < GROUP_MS;
  return { grouped, dayDivider, newDivider };
}

export function MessageList({
  workspaceId,
  roomId,
  perms,
  newMarker,
}: {
  workspaceId: string;
  roomId: string;
  perms: PermissionBits;
  newMarker: string;
}): ReactNode {
  const state = useMessages((s) => s.rooms[roomId] ?? EMPTY_ROOM_MESSAGES);
  const me = useSession((s) => s.me?.user?.id ?? '');
  const room = useRooms((s) => s.byId[roomId]);
  const items = state.items;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Prepending keeps the scroll position via Virtuoso's firstItemIndex.
  const firstKey = useRef<string | undefined>(undefined);
  const [firstIndex, setFirstIndex] = useState(START_INDEX);
  useEffect(() => {
    const prevFirst = firstKey.current;
    if (prevFirst) {
      const k = items.findIndex((c) => c.key === prevFirst);
      if (k > 0) setFirstIndex((i) => i - k);
    }
    firstKey.current = items[0]?.key;
  }, [items]);

  const lastSentId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const c = items[i];
      if (c?.status === 'sent') return c.msg.id;
    }
    return '';
  }, [items]);

  // Read state: the newest message is on screen and the window is focused.
  useEffect(() => {
    if (!atBottom || !lastSentId) return;
    const mark = (): void => {
      if (document.hasFocus()) markRead(roomId, lastSentId);
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [atBottom, lastSentId, roomId]);

  const startReached = useCallback(() => {
    if (state.hasMoreBefore && !state.loading) void loadOlder(roomId);
  }, [roomId, state.hasMoreBefore, state.loading]);

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      const last = items[items.length - 1];
      if (last && last.msg.authorId === me && last.status !== 'sent') return 'auto';
      return isAtBottom ? 'smooth' : false;
    },
    [items, me],
  );

  if (!state.loaded) {
    return (
      <div className="grid flex-1 place-items-center">
        {state.error ? (
          <button type="button" className="text-danger-text hover:underline" onClick={() => void loadOlder(roomId)}>
            {state.error} · {t('common.retry')}
          </button>
        ) : (
          <Spinner />
        )}
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <Virtuoso
        ref={virtuoso}
        className="selectable h-full"
        data={items}
        firstItemIndex={firstIndex}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        startReached={startReached}
        followOutput={followOutput}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={48}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        computeItemKey={(_i, c) => c.key}
        components={{
          Header: () =>
            state.hasMoreBefore ? (
              <div className="grid h-12 place-items-center">{state.loading ? <Spinner /> : null}</div>
            ) : (
              <div className="px-4 pb-2 pt-10">
                <div className="text-[26px] font-semibold">{t('chat.startTitle', { name: room?.name ?? '' })}</div>
                <div className="text-muted">{t('chat.startText')}</div>
              </div>
            ),
          Footer: () => <div className="h-3" />,
        }}
        itemContent={(index, c) => {
          const i = index - firstIndex;
          const prev = i > 0 ? items[i - 1] : undefined;
          return (
            <MessageRow
              c={c}
              meta={rowMeta(c, prev, newMarker, me)}
              workspaceId={workspaceId}
              roomId={roomId}
              perms={perms}
              isMe={c.msg.authorId === me}
            />
          );
        }}
      />
      {!atBottom ? (
        <button
          type="button"
          onClick={() => virtuoso.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
          className="absolute bottom-3 right-5 flex items-center gap-1 rounded-full bg-accent-strong px-3 py-1.5 text-[13px] font-medium text-accent-fg shadow-[var(--shadow-popover)]"
        >
          <ArrowDown className="size-4" /> {t('chat.toBottom')}
        </button>
      ) : null}
    </div>
  );
}
