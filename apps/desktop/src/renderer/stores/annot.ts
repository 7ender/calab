import { create } from 'zustand';

/** Annotation tool of this viewer (ADR-0028): none, laser pointer or pen. */
export type AnnotTool = 'none' | 'pointer' | 'pen';

export interface AnnotState {
  tool: AnnotTool;
  /** Pen / pointer colour (0xRRGGBB); null = my default colour (lib/annot/paint colorFor). */
  color: number | null;
  /** Presenter's policy per stream track sid (POLICY messages); absent = allowed. */
  policy: Record<string, boolean>;
  /** My own stream: viewers may annotate it (the switch in my stream's panel). */
  allowMine: boolean;
}

export const useAnnot = create<AnnotState>(() => ({ tool: 'none', color: null, policy: {}, allowMine: true }));

export const setAnnot = (p: Partial<AnnotState>): void => useAnnot.setState(p);
