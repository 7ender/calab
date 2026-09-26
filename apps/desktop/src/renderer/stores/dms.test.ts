import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { DmSummarySchema, MessageSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { dmWith, sortedDms, useDms } from './dms';

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const dm = (room: string, peer: string, lastAt: number, lastId = '') =>
  create(DmSummarySchema, {
    room: { id: room, type: RoomType.DM, lastMessageId: lastId, createdAt: timestampFromMs(1000) },
    peer: { id: peer, displayName: peer },
    ...(lastAt ? { lastMessageAt: timestampFromMs(lastAt) } : {}),
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

  it('an edit updates the preview, a deletion drops it (refetched later); READY keeps only fresh previews', () => {
    useDms.getState().setAll([dm('a', 'pa', 5000, id(1))]);
    useDms.getState().onMessage(msg('a', 1, 5000, 'x'));
    useDms.getState().onChanged('a', id(1), msg('a', 1, 5000, 'y'));
    expect(useDms.getState().preview['a']?.content).toBe('y');
    useDms.getState().setAll([dm('a', 'pa', 5000, id(1))]);
    expect(useDms.getState().preview['a']?.content).toBe('y');
    useDms.getState().setAll([dm('a', 'pa', 6000, id(2))]);
    expect(useDms.getState().preview['a']).toBeUndefined();
    useDms.getState().onMessage(msg('a', 2, 6000));
    useDms.getState().onChanged('a', id(2), null);
    expect(useDms.getState().preview['a']).toBeUndefined();
  });
});
