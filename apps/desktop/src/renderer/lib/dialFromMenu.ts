/**
 * «Позвонить на номер» from the room menu (docs/08): in this room's call — straight to the dial
 * popover; otherwise join the room's voice first (the normal join path, its errors and toasts
 * stay) and open the popover only if the call is really connected afterwards. Pure: the deps
 * are injected so the order is unit-tested.
 */
export interface DialFromMenuDeps {
  /** Connected (or reconnecting) in this room's call. */
  inCall: () => boolean;
  /** Open the room's chat (the header's dial button is its anchor; phone: the members drawer). */
  openRoom: () => void;
  /** The normal join; resolves when connect finished or failed. */
  join: () => Promise<void>;
  /** Phone: open the members drawer, where the dial sheet lives. No-op on desktop. */
  reveal: () => void;
  /** Ask the room's SipDialButton to open its popover. */
  open: () => void;
}

export async function dialFromMenu(d: DialFromMenuDeps): Promise<void> {
  d.openRoom();
  if (!d.inCall()) {
    await d.join();
    // Failed, pending admission, or left again meanwhile: no popover.
    if (!d.inCall()) return;
  }
  d.reveal();
  d.open();
}
