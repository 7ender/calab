import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { NotificationLevel, RoomCategorySchema, RoomNotificationSettingsSchema, RoomSchema, RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { defaultRoom, groupRooms, isQuiet, roomNotify, unreadMentionCounts, useRooms } from './rooms';

const room = (id: string, type: RoomType, position: number, categoryId = ''): ReturnType<typeof create<typeof RoomSchema>> =>
  create(RoomSchema, { id, workspaceId: 'w', type, name: id, position, categoryId });
const cat = (id: string, position: number): ReturnType<typeof create<typeof RoomCategorySchema>> =>
  create(RoomCategorySchema, { id, workspaceId: 'w', name: id, position });

const T = RoomType.TEXT;
const V = RoomType.VOICE;

describe('groupRooms', () => {
  it('puts loose rooms first, then categories by position; text before voice', () => {
    const rooms = [room('v1', V, 0), room('t2', T, 2), room('t1', T, 1, 'b'), room('v2', V, 0, 'a'), room('t3', T, 5, 'a')];
    const groups = groupRooms(rooms, [cat('b', 1), cat('a', 0)]);
    expect(groups.map((g) => [g.category?.id ?? null, g.rooms.map((r) => r.id)])).toEqual([
      [null, ['t2', 'v1']],
      ['a', ['t3', 'v2']],
      ['b', ['t1']],
    ]);
  });

  it('hides empty categories unless asked; unknown category ids count as loose', () => {
    const rooms = [room('t1', T, 0, 'gone')];
    expect(groupRooms(rooms, [cat('a', 0)]).map((g) => g.category?.id ?? null)).toEqual([null]);
    expect(groupRooms(rooms, [cat('a', 0)], true).map((g) => g.category?.id ?? null)).toEqual([null, 'a']);
  });

  it('defaultRoom prefers the first text room in list order', () => {
    expect(defaultRoom([room('v', V, 0), room('t', T, 3, 'a')], [cat('a', 0)])?.id).toBe('t');
    expect(defaultRoom([room('v', V, 0)], [])?.id).toBe('v');
    expect(defaultRoom([], [])).toBeUndefined();
  });
});

describe('room notifications', () => {
  const n = (level: NotificationLevel, until?: number): ReturnType<typeof create<typeof RoomNotificationSettingsSchema>> =>
    create(RoomNotificationSettingsSchema, { roomId: 'r', level, ...(until ? { mutedUntil: timestampFromMs(until) } : {}) });

  it('roomNotify: default ALL, expired mute ignored', () => {
    expect(roomNotify(undefined)).toEqual({ level: NotificationLevel.ALL, mutedUntil: null });
    expect(roomNotify(n(NotificationLevel.UNSPECIFIED))).toEqual({ level: NotificationLevel.ALL, mutedUntil: null });
    expect(roomNotify(n(NotificationLevel.MENTIONS, 5_000), 1_000)).toEqual({ level: NotificationLevel.MENTIONS, mutedUntil: 5_000 });
    expect(roomNotify(n(NotificationLevel.ALL, 5_000), 9_000).mutedUntil).toBeNull();
  });

  it('isQuiet: NONE or muted', () => {
    expect(isQuiet(roomNotify(n(NotificationLevel.NONE)))).toBe(true);
    expect(isQuiet(roomNotify(n(NotificationLevel.ALL, 5_000), 1_000))).toBe(true);
    expect(isQuiet(roomNotify(n(NotificationLevel.MENTIONS)))).toBe(false);
  });

  it('setNotify: the default removes the stored row', () => {
    useRooms.getState().setNotifyAll([n(NotificationLevel.NONE)]);
    expect(useRooms.getState().notify.r?.level).toBe(NotificationLevel.NONE);
    useRooms.getState().setNotify(n(NotificationLevel.ALL));
    expect(useRooms.getState().notify.r).toBeUndefined();
  });
});

describe('mention counters', () => {
  it('counts inbox mentions after each room read marker', () => {
    const items = [
      { id: '03', roomId: 'a' },
      { id: '02', roomId: 'a' },
      { id: '01', roomId: 'b' },
      { id: '05', roomId: 'c' },
    ];
    expect(unreadMentionCounts(items, { a: '02', b: '01' })).toEqual({ a: 1, c: 1 });
  });

  it('seedMentions only raises counters', () => {
    useRooms.getState().reset();
    useRooms.getState().addMention('a');
    useRooms.getState().addMention('a');
    useRooms.getState().seedMentions({ a: 1, b: 2 });
    expect(useRooms.getState().mentions).toEqual({ a: 2, b: 2 });
  });
});
