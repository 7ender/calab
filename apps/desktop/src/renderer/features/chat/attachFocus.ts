/**
 * Pure logic behind docs/09 #149 (Enter does nothing after a drop): a file staged from outside
 * the field — drag-and-drop above all, also paste, the paperclip and the camera — must leave the
 * composer's editor focused so Enter sends at once. `files` only grows when something is staged;
 * it shrinks when a chip is removed or the message is sent, and neither should steal focus back.
 * Kept as a pure predicate (like lastRowPin.ts) so the one true condition is unit-tested without
 * mounting the field.
 */
export function shouldFocusOnAttach(prevCount: number, nextCount: number): boolean {
  return nextCount > prevCount;
}
