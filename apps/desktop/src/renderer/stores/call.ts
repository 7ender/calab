import { create } from 'zustand';
import { IDLE, type CallModel } from '../lib/callModel';

/**
 * This device's one-to-one call (ADR-0034 §6): the model of lib/callModel.ts plus UI bits.
 * Written by services/call.ts only. Components select primitives (`phase`, `peerId`, `since`,
 * `call?.id`) — never the whole store.
 */
export interface CallStore extends CallModel {
  /** The other participant ('' when idle). */
  peerId: string;
  /** ms: when the phase's clock started — ACTIVE: the answer (header timer); ringing: the placing. */
  since: number | null;
  /** The outgoing modal collapsed into the top strip («Вызов … · Отменить») by a click outside. */
  collapsed: boolean;
  /** A call action is in flight (the modal's buttons wait). */
  busy: boolean;
}

export const useCall = create<CallStore>()(() => ({ ...IDLE, peerId: '', since: null, collapsed: false, busy: false }));

export const setCall = (p: Partial<CallStore>): void => useCall.setState(p);
