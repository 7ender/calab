import { describe, expect, it } from 'vitest';
import { roomMenuGroups, type RoomMenuInput } from './roomMenu';

const base: RoomMenuInput = { voice: true, mobile: false, guest: false, admin: false, canManage: false, canOrder: false, hasCategories: false };

describe('roomMenuGroups', () => {
  it('member in a voice room: recording, read, notifications', () => {
    expect(roomMenuGroups(base)).toEqual([['record'], ['markRead', 'notify']]);
  });

  it('owner / admin: invite, recording, settings, then the reorder items', () => {
    expect(roomMenuGroups({ ...base, admin: true, canManage: true, canOrder: true, hasCategories: true })).toEqual([
      ['invite', 'record', 'settings'],
      ['markRead', 'notify'],
      ['moveUp', 'moveDown', 'toCategory'],
    ]);
  });

  it('a room manager without admin invites by room link (voice only)', () => {
    expect(roomMenuGroups({ ...base, canManage: true })[0]).toEqual(['invite', 'record', 'settings']);
    expect(roomMenuGroups({ ...base, voice: false, canManage: true })[0]).toEqual(['settings']);
  });

  it('guest: no invite, no recording', () => {
    expect(roomMenuGroups({ ...base, guest: true, canManage: true })).toEqual([['settings'], ['markRead', 'notify']]);
    expect(roomMenuGroups({ ...base, guest: true })).toEqual([['markRead', 'notify']]);
  });

  it('text room: no recording, no chat item', () => {
    expect(roomMenuGroups({ ...base, voice: false, mobile: true, admin: true })[0]).toEqual(['invite']);
  });

  it('phone: the voice room chat comes first', () => {
    expect(roomMenuGroups({ ...base, mobile: true })[0]).toEqual(['openChat', 'record']);
  });

  it('no categories: no «В категорию ›»', () => {
    expect(roomMenuGroups({ ...base, canOrder: true })[2]).toEqual(['moveUp', 'moveDown']);
  });
});
