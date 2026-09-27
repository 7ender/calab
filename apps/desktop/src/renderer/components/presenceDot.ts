import { PresenceStatus } from '@calaba/protocol';

/**
 * Presence dot glyphs (docs/09 #29, Discord): a green dot, a yellow moon, a red dot with a bar,
 * a grey ring. «Невидимый» is shown as offline — to others it is offline (docs/05 «Presence»);
 * to myself the self panel passes my chosen status, so I see the ring too.
 */
export type PresenceGlyph = 'online' | 'idle' | 'dnd' | 'offline';

export function presenceGlyph(status: PresenceStatus | undefined): PresenceGlyph {
  switch (status) {
    case PresenceStatus.ONLINE:
      return 'online';
    case PresenceStatus.IDLE:
      return 'idle';
    case PresenceStatus.DND:
      return 'dnd';
    default:
      return 'offline';
  }
}

/** Fill colour of a glyph (non-text: the system yellow in both themes for idle, as before). */
export const GLYPH_FILL: Record<PresenceGlyph, string> = {
  online: 'bg-ok',
  idle: 'bg-[var(--color-presence-idle)]',
  dnd: 'bg-danger',
  offline: 'bg-faint',
};

/**
 * Geometry of the dot on an avatar of `size` px: it overlaps the avatar (Discord) — its centre
 * sits on the avatar's circle at 45°, bottom-right. `dot` is the coloured disc, `ring` the cutout
 * border in the surface colour around it, `offset` the CSS right/bottom of the whole element
 * (negative = sticks out of the avatar's box).
 */
export function presenceDotGeometry(size: number): { dot: number; ring: number; offset: number } {
  const dot = Math.min(20, Math.max(8, 2 * Math.round(size * 0.1875))); // 32 → 12, 28 → 10, 56+ → 20
  const ring = size >= 56 ? 4 : 2;
  const r = size / 2;
  const fromEdge = r - r / Math.SQRT2; // the 45° point of the circle, from the box's right / bottom
  const offset = Math.round(fromEdge - (dot / 2 + ring)); // whole pixels: a crisp edge
  return { dot, ring, offset };
}
