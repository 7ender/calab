/**
 * Pure helpers of the web apps UI (ADR-0050 §3): the letter plate, reordering in the rail, and
 * which overlays must hide the desktop view (a native view is drawn above the whole page, so a
 * menu or a dialog over the content area would be hidden behind the site).
 */

/** The first letter or digit of the name, upper-cased («grafana» → «G»); «?» for none. */
export function appInitial(name: string): string {
  for (const ch of name.trim()) if (/[\p{L}\p{N}]/u.test(ch)) return ch.toLocaleUpperCase();
  return '?';
}

export interface Slot {
  id: string;
  top: number;
  bottom: number;
}

/**
 * Where a dragged icon lands in the column: the new index among the others and the y of the
 * insertion line (relative to the list); null = its own place (no move).
 */
export function appDropAt(slots: readonly Slot[], y: number, draggedId: string): { index: number; lineY: number } | null {
  const from = slots.findIndex((s) => s.id === draggedId);
  if (from < 0 || !slots.length) return null;
  let at = slots.length;
  for (const [i, s] of slots.entries()) {
    if (y < (s.top + s.bottom) / 2) {
      at = i;
      break;
    }
  }
  const index = at > from ? at - 1 : at;
  if (index === from) return null;
  const lineY = at < slots.length ? (slots[at]?.top ?? 0) - 2 : (slots[slots.length - 1]?.bottom ?? 0) + 2;
  return { index, lineY };
}

/**
 * Moves `id` to `index` of `ids`: the new order and the neighbours the server needs (PUT
 * …/position: after / before, "" at an end).
 */
export function moveApp(ids: readonly string[], id: string, index: number): { order: string[]; after: string; before: string } {
  const rest = ids.filter((x) => x !== id);
  const at = Math.max(0, Math.min(index, rest.length));
  const order = [...rest.slice(0, at), id, ...rest.slice(at)];
  return { order, after: rest[at - 1] ?? '', before: rest[at] ?? '' };
}

/** The bits of an element the overlay check reads (a DOM Element in the app, a stub in tests). */
export interface OverlayNode {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): unknown;
}

/**
 * A top-level child of <body> that covers content: a Radix popper (menu, popover, select) that is
 * not just a tooltip, or a dialog. Tooltips are ignored — hovering the rail must not blink the
 * site away.
 */
export function coversContent(el: OverlayNode): boolean {
  if (el.hasAttribute('data-radix-popper-content-wrapper')) return !el.querySelector('[role="tooltip"]');
  const role = el.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog' || role === 'menu') return true;
  return !!el.querySelector('[role="dialog"],[role="alertdialog"]');
}
