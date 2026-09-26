import { create } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import { RoomInviteSchema, type RoomInvite } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { reusableInvite } from './inviteChoice';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const inv = (id: string, o: { exp?: number; max?: number; uses?: number; guests?: boolean; created?: number } = {}): RoomInvite =>
  create(RoomInviteSchema, {
    id,
    code: id,
    maxUses: o.max ?? 0,
    uses: o.uses ?? 0,
    allowGuests: o.guests ?? true,
    ...(o.exp !== undefined ? { expiresAt: timestampFromMs(o.exp) } : {}),
    createdAt: timestampFromMs(o.created ?? NOW - 3600_000),
  });

describe('reusableInvite', () => {
  it('returns null when there is nothing to reuse', () => {
    expect(reusableInvite([], NOW)).toBeNull();
  });

  it('skips expired, soon-expiring and used-up links', () => {
    const list = [inv('expired', { exp: NOW - 1 }), inv('soon', { exp: NOW + 60_000 }), inv('full', { max: 5, uses: 5 })];
    expect(reusableInvite(list, NOW)).toBeNull();
  });

  it('keeps links without expiry or with uses left', () => {
    expect(reusableInvite([inv('forever')], NOW)?.id).toBe('forever');
    expect(reusableInvite([inv('left', { max: 5, uses: 4, exp: NOW + 86_400_000 })], NOW)?.id).toBe('left');
  });

  it('prefers guest links, then the newest', () => {
    const list = [
      inv('members-new', { guests: false, created: NOW - 1000 }),
      inv('guests-old', { created: NOW - 90_000 }),
      inv('guests-new', { created: NOW - 5000 }),
    ];
    expect(reusableInvite(list, NOW)?.id).toBe('guests-new');
    expect(reusableInvite([list[0] as RoomInvite], NOW)?.id).toBe('members-new');
  });
});
