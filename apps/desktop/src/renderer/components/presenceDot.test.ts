import { PresenceStatus } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { presenceDotGeometry, presenceGlyph } from './presenceDot';

describe('presenceGlyph (docs/09 #29)', () => {
  it('maps statuses to dot / moon / bar / ring', () => {
    expect(presenceGlyph(PresenceStatus.ONLINE)).toBe('online');
    expect(presenceGlyph(PresenceStatus.IDLE)).toBe('idle');
    expect(presenceGlyph(PresenceStatus.DND)).toBe('dnd');
    // Invisible looks offline; unknown / offline — the grey ring.
    expect(presenceGlyph(PresenceStatus.INVISIBLE)).toBe('offline');
    expect(presenceGlyph(PresenceStatus.OFFLINE)).toBe('offline');
    expect(presenceGlyph(undefined)).toBe('offline');
  });
});

describe('presenceDotGeometry', () => {
  it('self panel / members: 12 px dot, 2 px ring on a 32 px avatar', () => {
    expect(presenceDotGeometry(32)).toMatchObject({ dot: 12, ring: 2 });
  });

  it.each([28, 32, 40, 56, 80])('the dot centre sits on the %i px circle at 45° (±1 px)', (size) => {
    const { dot, ring, offset } = presenceDotGeometry(size);
    const half = dot / 2 + ring;
    const centre = size - offset - half; // from the box's top-left, both axes
    const r = size / 2;
    const dist = Math.hypot(centre - r, centre - r);
    expect(Math.abs(dist - r)).toBeLessThanOrEqual(1.5);
    // Overlaps the avatar: at least a third of the dot lies inside the circle's box.
    expect(-offset).toBeLessThan(half);
  });
});
