import { create } from 'zustand';

/**
 * State of the camera background effect (ADR-0035) for the UI: the preview's loading indicator and
 * the hints. Changes only on transitions (a few times per choice), never per frame.
 */
export interface CameraBgState {
  /** idle: no effect; loading: model on its way (frames pass through); ready; failed: unavailable here. */
  state: 'idle' | 'loading' | 'ready' | 'failed';
  /** No GPU delegate / software WebGL: segmentation at 6 fps, «нагружает процессор». */
  software: boolean;
  /** The camera blurs by itself (Windows Studio Effects): «системное размытие». */
  hardware: boolean;
}

export const useCameraBg = create<CameraBgState>()(() => ({ state: 'idle', software: false, hardware: false }));

export function setCameraBg(p: Partial<CameraBgState>): void {
  const cur = useCameraBg.getState();
  if ((Object.keys(p) as (keyof CameraBgState)[]).every((k) => cur[k] === p[k])) return;
  useCameraBg.setState(p);
}
