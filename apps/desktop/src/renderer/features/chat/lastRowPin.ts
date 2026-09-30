/**
 * Pure logic behind docs/09 #149 (a reaction clipped by the composer): when the last row of the
 * feed grows (a reaction pill added, mine or incoming) while the feed sits at the bottom, the
 * scroll should be pinned back to the bottom so the new pill clears the composer. Kept out of the
 * component (like hoverIntent.ts) so the decision — grow *and* at bottom → pin — is unit-testable
 * without a real ResizeObserver or DOM; the caller does the actual scrolling, since that touches a
 * ref and belongs in an effect, not in this stateless tracker.
 */
export interface LastRowPin {
  /** The feed's atBottom flag changed (Virtuoso's atBottomStateChange, threshold ~1 row). */
  setAtBottom(atBottom: boolean): void;
  /** The last row's measured height, on every layout pass (a ResizeObserver entry). Returns
   * whether the caller should re-anchor the scroller to the bottom. */
  measure(height: number): boolean;
  /** The identity of the last row changed (a new message became last): re-baseline, never pin. */
  reset(height: number): void;
}

export function createLastRowPin(): LastRowPin {
  let atBottom = false;
  let height = 0;
  return {
    setAtBottom(v) {
      atBottom = v;
    },
    measure(h) {
      const grew = h > height && atBottom;
      height = h;
      return grew;
    },
    reset(h) {
      height = h;
    },
  };
}
