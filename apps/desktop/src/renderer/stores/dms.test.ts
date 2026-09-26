import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { DmSummarySchema, MessageSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { dmWith, sortedDms, useDms } from './dms';

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
});
