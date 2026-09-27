import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { DmSummarySchema, MessageSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { dmWith, isHiddenDm, sortedDms, splitDms, useDms } from './dms';

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const dm = (room: string, peer: string, lastAt: number, lastId = '', lastText = 'x') =>
  create(DmSummarySchema, {
    room: { id: room, type: RoomType.DM, lastMessageId: lastId, createdAt: timestampFromMs(1000) },
    peer: { id: peer, displayName: peer },
    ...(lastAt ? { lastMessageAt: timestampFromMs(lastAt) } : {}),
    ...(lastId ? { lastMessage: { id: lastId, authorId: peer, content: lastText, attachmentCount: 0, createdAt: timestampFromMs(lastAt) } } : {}),
  });
const msg = (room: string, n: number, at: number, content = 'hi') =>
  create(MessageSchema, { id: id(n), roomId: room, authorId: 'p', content, createdAt: timestampFromMs(at) });

beforeEach(() => useDms.getState().reset());

describe('dms store', () => {
  it('orders by last activity, a new message moves the DM up and becomes its preview', () => {
    useDms.getState().setAll([dm('a', 'pa', 5000), dm('b', 'pb', 9000), dm('c', 'pc', 0)]);
    expect(sortedDms(useDms.getState().byRoom).map((e) => e.roomId)).toEqual(['b', 'a', 'c']);
    useDms.getState().onMessage(msg('c', 10, 20_000, 'новое'));
    expect(sortedDms(useDms.getState().byRoom).map((e) => e.roomId)).toEqual(['c', 'b', 'a']);
    expect(useDms.getState().preview['c']?.content).toBe('новое');
    // An older message (replay) does not replace the preview.
    useDms.getState().onMessage(msg('c', 9, 19_000, 'старое'));
    expect(useDms.getState().preview['c']?.content).toBe('новое');
    expect(dmWith('pc')?.roomId).toBe('c');
  });

  it('previews come with the summaries (no fetch); an edit updates, a deletion drops them; a newer live one wins', () => {
    useDms.getState().setAll([dm('a', 'pa', 5000, id(1), 'из READY'), dm('b', 'pb', 0)]);
    expect(useDms.getState().preview['a']?.content).toBe('из READY');
    expect(useDms.getState().preview['b']).toBeNull(); // no messages: known empty
    useDms.getState().onChanged('a', id(1), msg('a', 1, 5000, 'y'));
    expect(useDms.getState().preview['a']?.content).toBe('y');
    // A later READY replaces the previews with its own.
    useDms.getState().setAll([dm('a', 'pa', 6000, id(2), 'новое')]);
    expect(useDms.getState().preview['a']?.content).toBe('новое');
    // DM_CREATE / GET /api/dms older than a live message keeps the live one.
    useDms.getState().onMessage(msg('a', 3, 7000, 'живое'));
    useDms.getState().upsert(dm('a', 'pa', 6000, id(2), 'новое'));
    expect(useDms.getState().preview['a']?.content).toBe('живое');
    useDms.getState().onChanged('a', id(3), null);
    expect(useDms.getState().preview['a']).toBeUndefined();
  });

  it('archive and «Удалить чат» (docs/09 #51): the summary state, the split, hidden until a new message', () => {
    const archived = dm('c', 'pc', 3000, id(3));
    archived.archivedAt = timestampFromMs(4000);
    useDms.getState().setAll([dm('a', 'pa', 5000, id(5)), dm('b', 'pb', 9000, id(9)), archived]);
    expect(useDms.getState().byRoom['c']).toMatchObject({ archivedAt: 4000, clearedBefore: '' });
    const split = () => {
      const r = splitDms(useDms.getState().byRoom, useDms.getState().preview);
      return { main: r.main.map((e) => e.roomId), archived: r.archived.map((e) => e.roomId) };
    };
    expect(split()).toEqual({ main: ['b', 'a'], archived: ['c'] });

    // «Удалить чат» of b: the preview it hides goes, b leaves the list (unless it is the open chat).
    useDms.getState().setState('b', 0, id(10));
    expect(useDms.getState().preview['b']).toBeNull();
    expect(isHiddenDm(useDms.getState().byRoom['b']!, null)).toBe(true);
    expect(split()).toEqual({ main: ['a'], archived: ['c'] });
    expect(splitDms(useDms.getState().byRoom, useDms.getState().preview, 'b').main.map((e) => e.roomId)).toEqual(['b', 'a']);
    // A new message after the mark: the same DM is back as a clean chat.
    useDms.getState().onMessage(msg('b', 11, 20_000, 'снова'));
    expect(split()).toEqual({ main: ['b', 'a'], archived: ['c'] });

    // Un-archive; a summary without a state (never cleared) is not hidden when it has no messages.
    useDms.getState().setState('c', 0, '');
    expect(split().archived).toEqual([]);
    expect(isHiddenDm({ roomId: 'x', peerId: 'px', activity: 0, archivedAt: 0, clearedBefore: '' }, null)).toBe(false);
    // A preview being refetched (undefined) does not hide a cleared DM.
    expect(isHiddenDm({ roomId: 'x', peerId: 'px', activity: 0, archivedAt: 0, clearedBefore: id(1) }, undefined)).toBe(false);
  });
});
