/**
 * docs/09 #118: a modal Radix Dialog locks scroll with react-remove-scroll: it cancels every
 * wheel/touchmove at the document unless the target is inside the Overlay's React subtree or the
 * Content's DOM. Popovers, dropdown menus, selects and context menus are portaled to <body>, so
 * inside a dialog (create task → assignees, task panel pickers, emoji picker) their lists could
 * not scroll.
 *
 * One delegate for all of them: Radix wraps every popper-positioned content in
 * `[data-radix-popper-content-wrapper]`, and custom portals opt in with `data-scroll-shard`. The
 * listener sits on <body> (bubble phase), i.e. below the lock's document listener, and stops the
 * event there: the lock never sees it, the browser still scrolls the list under the pointer.
 * Nothing behind a popover moves: the body is not scrollable and lists use overscroll-contain.
 * The idle tracker listens in the capture phase on window and is unaffected.
 */
const SHARD = '[data-radix-popper-content-wrapper],[data-scroll-shard]';

function stopInPopover(e: Event): void {
  const t = e.target;
  if (t instanceof Element && t.closest(SHARD)) e.stopPropagation();
}

/** Installs the delegate once per document; returns the uninstall function. */
export function installPopoverScroll(doc: Document = document): () => void {
  const body = doc.body;
  body.addEventListener('wheel', stopInPopover, { passive: true });
  body.addEventListener('touchmove', stopInPopover, { passive: true });
  return () => {
    body.removeEventListener('wheel', stopInPopover);
    body.removeEventListener('touchmove', stopInPopover);
  };
}
