import { create } from '@bufbuild/protobuf';
import { RoomSchema, RoomType, type Room } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import type { MemberPickItem } from '../people/memberPickItems';
import { MAX_FORWARD_TARGETS, forwardGroups, isSelected, roomItems, shelfItems, targetKey, toggleTarget, type ForwardItem, type RoomPickItem } from './forwardModel';

const person = (id: string, name: string): MemberPickItem => ({
  kind: 'member',
  id,
  userId: id,
  name,
  secondary: '',
  avatarFileId: '',
  role: undefined,
  guest: false,
  note: '',
  search: [name],
});
const room = (id: string, name: string, type = RoomType.TEXT, position = 0): Room => create(RoomSchema, { id, name, type, position, workspaceId: 'ws' });
const roomItem = (id: string, name: string): RoomPickItem => ({ kind: 'room', id, roomId: id, name: `#${name}`, voice: false, search: [name] });

describe('forward targets', () => {
  it('keys people and rooms apart even with equal ids', () => {
    expect(targetKey(person('x', 'Аня'))).not.toBe(targetKey(roomItem('x', 'общий')));
  });

  it('toggles a pick: appends in picking order, removes a chosen one', () => {
    const a = person('a', 'Аня');
    const r = roomItem('r', 'общий');
    let sel: ForwardItem[] = [];
    sel = toggleTarget(sel, a).next;
    sel = toggleTarget(sel, r).next;
    expect(sel.map(targetKey)).toEqual(['u:a', 'r:r']);
    expect(isSelected(sel, person('a', 'другое имя'))).toBe(true);
    const off = toggleTarget(sel, a);
    expect(off.full).toBe(false);
    expect(off.next.map(targetKey)).toEqual(['r:r']);
  });

  it('refuses a pick past the limit but still lets one go', () => {
    const sel = Array.from({ length: MAX_FORWARD_TARGETS }, (_, i) => person(`p${i}`, `P${i}`));
    const more = toggleTarget(sel, person('extra', 'Extra'));
    expect(more.full).toBe(true);
    expect(more.next).toHaveLength(MAX_FORWARD_TARGETS);
    expect(toggleTarget(sel, person('p3', 'P3')).next).toHaveLength(MAX_FORWARD_TARGETS - 1);
  });

  it('lists rooms I may send to, in sidebar order, without DMs', () => {
    const rooms = [room('b', 'бета', RoomType.TEXT, 2), room('a', 'альфа', RoomType.VOICE, 1), room('d', '', RoomType.DM, 0), room('x', 'закрытая', RoomType.TEXT, 0)];
    const items = roomItems(rooms, (r) => r.id !== 'x', (r) => `#${r.name}`);
    expect(items.map((i) => i.roomId)).toEqual(['a', 'b']);
    expect(items[0]?.voice).toBe(true);
  });

  it('filters rooms by the query here and keeps the server people as they are', () => {
    const people = [person('a', 'Аня')];
    const rooms = [{ id: 'ws', label: 'Комнаты', items: [roomItem('r1', 'общий'), roomItem('r2', 'дизайн')] }];
    const g = forwardGroups(people, rooms, 'диз', 'Личные');
    expect(g.map((x) => x.id)).toEqual(['people', 'rooms:ws']);
    expect(g[1]?.items.map((i) => i.id)).toEqual(['r2']);
    expect(forwardGroups([], rooms, 'нет такого', 'Личные')).toEqual([]);
  });

  it('puts my shelves first, without the source shelf, and filters them by the query', () => {
    const shelves = shelfItems(
      [
        { roomId: 's1', name: 'Идеи', emoji: '💡' },
        { roomId: 's2', name: 'Ссылки', emoji: '' },
      ],
      's2',
    );
    expect(shelves.map((i) => [i.roomId, i.notes, i.emoji])).toEqual([['s1', true, '💡']]);
    const rooms = [{ id: 'ws', label: 'Комнаты', items: [roomItem('r1', 'идеи команды')] }];
    const g = forwardGroups([person('a', 'Аня')], rooms, 'иде', 'Личные', { label: 'Заметки', items: shelves });
    expect(g.map((x) => x.id)).toEqual(['notes', 'people', 'rooms:ws']);
    expect(roomItems([room('n', 'Идеи', RoomType.NOTES, 0)], () => true, (r) => r.name)).toEqual([]);
  });
});
