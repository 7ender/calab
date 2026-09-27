/**
 * Room header fit (owner's bug 27.09): the header lives in the chat column, whose width depends on
 * the room column (200–320 px), the members column (240 px from 1200 px) and the window — not on
 * the window alone. When space runs out the spacing tightens first, then the room name truncates.
 * The right-hand buttons never leave the column. Workspace search is in the title bar only
 * (docs/09 #53).
 */

/** Header padding at normal spacing: pl-4 + pr-2. */
export const HEADER_PAD = 24;
/** Gap between the header's items at normal spacing (gap-2). */
export const HEADER_GAP = 8;
/** The room name's cap (max-w-[40%] of the header's content box). */
export const HEADER_NAME_SHARE = 0.4;

export interface HeaderFit {
  /** The items don't fit at normal spacing: tighten the padding and gaps. */
  tight: boolean;
}

/**
 * `width`: the header's width. `used`: everything but the topic, at normal spacing, with the room
 * name at its natural (capped) width — independent of `tight`, so toggling it never feeds back
 * into the decision.
 */
export function headerFit(width: number, used: number): HeaderFit {
  return { tight: used > width };
}

/**
 * Measures `used` from the rendered header: direct children marked `data-header-fill` (the
 * flexible topic) count as zero, `data-header-name` counts at its full text width up to the cap.
 */
export function measureHeader(header: HTMLElement): { width: number; used: number } {
  const width = header.clientWidth;
  const items = [...header.children] as HTMLElement[];
  let used = HEADER_PAD + HEADER_GAP * Math.max(0, items.length - 1);
  for (const el of items) {
    if (el.hasAttribute('data-header-fill')) continue;
    if (el.hasAttribute('data-header-name')) {
      used += Math.min(el.scrollWidth, HEADER_NAME_SHARE * (width - HEADER_PAD));
      continue;
    }
    used += el.getBoundingClientRect().width;
  }
  return { width, used };
}
