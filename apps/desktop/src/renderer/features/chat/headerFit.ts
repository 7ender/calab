/**
 * Room header fit (owner's bug 27.09): the header lives in the chat column, whose width depends on
 * the room column (200–320 px), the members column (240 px from 1200 px) and the window — not on
 * the window alone. What goes when space runs out, in order: the workspace search field (⌘K stays
 * in the title bar), then the spacing tightens, then the room name truncates. The right-hand
 * buttons never leave the column.
 */

/** Header padding at normal spacing: pl-4 + pr-2. */
export const HEADER_PAD = 24;
/** Gap between the header's items at normal spacing (gap-2). */
export const HEADER_GAP = 8;
/** The search field's share of the button group: 240 px field + 4 px margin + 2 px group gap. */
export const HEADER_SEARCH_SLOT = 246;
/** Room kept for the topic («• описание» / «печатает») next to the search field: none — it truncates to its bullet first. */
export const HEADER_TOPIC_MIN = 0;
/** The room name's cap (max-w-[40%] of the header's content box). */
export const HEADER_NAME_SHARE = 0.4;

export interface HeaderFit {
  /** Show the workspace search field. */
  search: boolean;
  /** Even without it the items don't fit at normal spacing: tighten the padding and gaps. */
  tight: boolean;
}

/**
 * `width`: the header's width. `used`: everything but the search field and the topic, at normal
 * spacing, with the room name at its natural (capped) width — independent of `search` and
 * `tight`, so toggling either never feeds back into the decision.
 */
export function headerFit(width: number, used: number): HeaderFit {
  return { search: used + HEADER_SEARCH_SLOT + HEADER_TOPIC_MIN <= width, tight: used > width };
}

/**
 * Measures `used` from the rendered header: direct children marked `data-header-fill` (the
 * flexible topic) count as zero, `data-header-name` counts at its full text width up to the cap,
 * and the element marked `data-header-search` (inside the button group) is left out.
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
    const search = el.querySelector<HTMLElement>('[data-header-search]');
    if (search) used -= HEADER_SEARCH_SLOT;
  }
  return { width, used };
}
