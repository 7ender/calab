import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { RoomInviteSchema, RoomType, type RoomInvite } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { guestInviteMode, guestLink, guestLinkDefaults } from './roomGuestInvite';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const inv = (id: string, o: { exp?: number; guests?: boolean } = {}): RoomInvite =>
  create(RoomInviteSchema, {
    id,
    code: id,
    allowGuests: o.guests ?? true,
    ...(o.exp !== undefined ? { expiresAt: timestampFromMs(o.exp) } : {}),
    createdAt: timestampFromMs(NOW - 3600_000),
  });
const text = { type: RoomType.TEXT };
const voice = { type: RoomType.VOICE };

describe('guestInviteMode', () => {
  it('shows the existing guest link right away', () => {
    expect(guestInviteMode({ room: text, canCreate: true, invites: [inv('a', { exp: NOW + 86400_000 })], nowMs: NOW })).toBe('link');
    expect(guestInviteMode({ room: voice, canCreate: true, invites: [inv('a')], nowMs: NOW })).toBe('link');
  });

  it('offers to create one when there is no usable guest link', () => {
    expect(guestInviteMode({ room: text, canCreate: true, invites: [], nowMs: NOW })).toBe('create');
    const list = [inv('expired', { exp: NOW - 1 }), inv('members-only', { guests: false })];
    expect(guestInviteMode({ room: voice, canCreate: true, invites: list, nowMs: NOW })).toBe('create');
  });

  it('waits for the list', () => {
    expect(guestInviteMode({ room: text, canCreate: true, invites: undefined, nowMs: NOW })).toBe('loading');
  });

  it('is hidden without the right, in a DM and outside a room', () => {
    expect(guestInviteMode({ room: text, canCreate: false, invites: [inv('a')], nowMs: NOW })).toBe('hidden');
    expect(guestInviteMode({ room: { type: RoomType.DM }, canCreate: true, invites: [inv('a')], nowMs: NOW })).toBe('hidden');
    expect(guestInviteMode({ room: undefined, canCreate: true, invites: [inv('a')], nowMs: NOW })).toBe('hidden');
  });
});

describe('guestLink / defaults', () => {
  it('skips links closed to guests', () => {
    expect(guestLink([inv('m', { guests: false }), inv('g')], NOW)?.id).toBe('g');
  });

  it('creates 7-day unlimited links that let guests speak (voice) and write', () => {
    expect(guestLinkDefaults(true)).toMatchObject({ expiresInSeconds: 604800, maxUses: 0, allowGuests: true, allowSpeak: true, allowMessages: true, allowFiles: false });
    expect(guestLinkDefaults(false).allowSpeak).toBe(false);
  });
});
