import { create } from 'zustand';
import type { RecordingMap } from '../lib/recording';

/**
 * Rooms being recorded now (ADR-0025), roomId → who / since — the server's state: READY /
 * WORKSPACE_CREATE `recordings[]` and ROOM_RECORDING (services/recording.ts applies them; the
 * pure transitions are lib/recording.ts). The REC indicator of any room reads it; `voice.recording`
 * mirrors the entry of my own room.
 */
interface RecordingsState {
  byRoom: RecordingMap;
  set: (byRoom: RecordingMap) => void;
}

export const useRecordings = create<RecordingsState>()((set) => ({
  byRoom: {},
  set: (byRoom) => set({ byRoom }),
}));
