import { create } from '@bufbuild/protobuf';
import { RoomSchema, RoomType } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { inboxBadgeCount, unreadInboxItems } from './inboxUnread';

const room = (id: string, type = RoomType.TEXT) => create(RoomSchema, { id, workspaceId: 'w', type, name: id });
const byId = { a: room('a'), b: room('b'), dm: room('dm', RoomType.DM) };
const m = (id: string, roomId: string) => ({ id, roomId });

describe('unreadInboxItems', () => {
  const items = [m('05', 'a'), m('04', 'b'), m('03', 'a'), m('01', 'a')];
  it('keeps only mentions after the room read marker', () => {
    expect(unreadInboxItems(items, { a: '03', b: '09' }).map((x) => x.id)).toEqual(['05']);
  });
  it('a room without a marker has everything unread', () => {
    expect(unreadInboxItems(items, {})).toHaveLength(4);
  });
  it('reading exactly to the message marks it read', () => {
    expect(unreadInboxItems([m('05', 'a')], { a: '05' })).toEqual([]);
  });
  it('drops unknown rooms', () => {
    expect(unreadInboxItems(items, {}, (id) => id === 'b')).toEqual([m('04', 'b')]);
  });
});

describe('inboxBadgeCount', () => {
  const full = { items: [m('05', 'a'), m('04', 'b'), m('03', 'a')], loaded: true, hasMore: false };
  it('counts unread items of fully loaded history, ignoring stale server counts', () => {
    expect(inboxBadgeCount(full, { a: '03' }, { a: 2, b: 1 }, byId)).toBe(2);
    expect(inboxBadgeCount(full, { a: '05', b: '04' }, { a: 2, b: 1 }, byId)).toBe(0);
  });
  it('falls back to the server count when older history is not loaded', () => {
    const partial = { items: [m('09', 'a')], loaded: true, hasMore: true };
    expect(inboxBadgeCount(partial, { a: '02' }, { a: 4 }, byId)).toBe(4);
    // history reaches back past the marker: exact again
    expect(inboxBadgeCount({ items: [m('09', 'a'), m('03', 'a')], loaded: true, hasMore: true }, { a: '03', b: '01' }, { a: 4 }, byId)).toBe(1);
  });
  it('before the history loads only the server counts count', () => {
    expect(inboxBadgeCount({ items: [], loaded: false, hasMore: false }, {}, { a: 3, b: 2 }, byId)).toBe(5);
  });
  it('ignores DMs and unknown rooms', () => {
    expect(inboxBadgeCount({ items: [], loaded: false, hasMore: false }, {}, { dm: 7, zz: 2, a: 1 }, byId)).toBe(1);
  });
});
