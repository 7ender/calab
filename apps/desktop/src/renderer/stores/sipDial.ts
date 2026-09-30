import { create } from 'zustand';

/**
 * «Позвонить на номер» asked from the room menu (docs/08): the room whose dial popover should
 * open as soon as its button can show it (SipDialButton consumes the request). A request that is
 * not consumed within a few seconds (the gate never passed) lapses, so a popover never appears
 * out of the blue later.
 */
interface SipDialState {
  roomId: string | null;
  request: (roomId: string) => void;
  clear: (roomId: string) => void;
}

const LAPSE_MS = 5000;
let timer: ReturnType<typeof setTimeout> | undefined;

export const useSipDial = create<SipDialState>()((set, get) => ({
  roomId: null,
  request: (roomId) => {
    clearTimeout(timer);
    set({ roomId });
    timer = setTimeout(() => get().clear(roomId), LAPSE_MS);
  },
  clear: (roomId) => {
    if (get().roomId !== roomId) return;
    clearTimeout(timer);
    set({ roomId: null });
  },
}));
