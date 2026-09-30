import { create } from 'zustand';
import type { SipCallMap } from '../lib/sip';

/**
 * Phone lines of voice rooms (ADR-0046), roomId → the room's call — the server's state: READY /
 * WORKSPACE_CREATE `sip_calls[]` and SIP_CALL_UPDATE (services/sip.ts applies them; the pure
 * transitions are lib/sip.ts). The phone participant row and the «Позвонить на номер» gate read
 * it with per-room selectors; the store changes only on a status change, never per tick.
 */
interface SipCallsState {
  byRoom: SipCallMap;
  set: (byRoom: SipCallMap) => void;
}

export const useSipCalls = create<SipCallsState>()((set) => ({
  byRoom: {},
  set: (byRoom) => set({ byRoom }),
}));
