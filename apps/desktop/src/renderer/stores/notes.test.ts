import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { MessageSchema, NotesShelfSchema, RoomType } from '@calaba/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { firstShelf, movedPositions, shelfDropAt, shelfTitle, sortedShelves, useNotes } from './notes';

const id = (n: number): string => `0190a0b0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const shelf = (room: string, name: string, position: number, emoji = '', last = 0) =>
  create(NotesShelfSchema, {
    room: { id: room, type: RoomType.NOTES, name, position, createdAt: timestampFromMs(1000) },
    emoji,
    ...(last ? { lastMessage: { id: id(last), authorId: 'me', content: `m${last}`, createdAt: timestampFromMs(last) } } : {}),
  });
const msg = (room: string, n: number) => create(MessageSchema, { id: id(n), roomId: room, authorId: 'me', content: `m${n}`, createdAt: timestampFromMs(n) });

beforeEach(() => useNotes.getState().reset());

describe('notes store', () => {
  it('lists shelves by position with their previews', () => {
    useNotes.getState().setAll([shelf('b', 'Ссылки', 1), shelf('a', 'Идеи', 0, '💡', 5)]);
    const list = sortedShelves(useNotes.getState().byRoom);
    expect(list.map((e) => e.roomId)).toEqual(['a', 'b']);
    expect(firstShelf(useNotes.getState().byRoom)).toBe('a');
    expect(useNotes.getState().preview['a']?.content).toBe('m5');
    expect(useNotes.getState().preview['b']).toBeNull();
    expect(list.map(shelfTitle)).toEqual(['💡 Идеи', 'Ссылки']);
  });

  it('keeps the newest preview and ignores messages of other rooms', () => {
    useNotes.getState().setAll([shelf('a', 'Идеи', 0, '', 5)]);
    useNotes.getState().onMessage(msg('a', 9));
    useNotes.getState().onMessage(msg('a', 7));
    useNotes.getState().onMessage(msg('dm', 10));
    expect(useNotes.getState().preview['a']?.content).toBe('m9');
    expect(useNotes.getState().preview['dm']).toBeUndefined();
    useNotes.getState().onChanged('a', id(9), null);
    expect(useNotes.getState().preview['a']).toBeUndefined();
  });

  it('removes a shelf', () => {
    useNotes.getState().setAll([shelf('a', 'Идеи', 0)]);
    useNotes.getState().remove('a');
    expect(useNotes.getState().byRoom).toEqual({});
  });
});

describe('movedPositions', () => {
  const list = [
    { roomId: 'a', name: 'A', emoji: '', position: 0 },
    { roomId: 'b', name: 'B', emoji: '', position: 1 },
    { roomId: 'c', name: 'C', emoji: '', position: 2 },
  ];
  it('renumbers like the server and returns only the changes', () => {
    expect(movedPositions(list, 'c', 0)).toEqual({ c: 0, a: 1, b: 2 });
    expect(movedPositions(list, 'a', 1)).toEqual({ b: 0, a: 1 });
    expect(movedPositions(list, 'a', 99)).toEqual({ b: 0, c: 1, a: 2 });
    expect(movedPositions(list, 'b', 1)).toEqual({});
    expect(movedPositions(list, 'x', 0)).toEqual({});
  });
});

describe('shelfDropAt', () => {
  const slots = [
    { id: 'a', top: 0, bottom: 46 },
    { id: 'b', top: 47, bottom: 93 },
    { id: 'c', top: 94, bottom: 140 },
  ];
  it('drops between rows by the pointer, not where the shelf already is', () => {
    expect(shelfDropAt(slots, 10, 'c')).toEqual({ index: 0, lineY: 0 });
    expect(shelfDropAt(slots, 80, 'a')).toEqual({ index: 1, lineY: 94 });
    expect(shelfDropAt(slots, 139, 'a')).toEqual({ index: 2, lineY: 140 });
    expect(shelfDropAt(slots, 60, 'b')).toBeNull();
    expect(shelfDropAt(slots, 30, 'a')).toBeNull();
    expect(shelfDropAt(slots, 10, 'x')).toBeNull();
  });
});
