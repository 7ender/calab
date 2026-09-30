import type { Room } from '@calaba/protocol';
import { create } from 'zustand';
import { useUi } from './ui';

/**
 * «Открыть историю» of an archived temporary room (ADR-0044): the room is not in the live list
 * (useRooms), so its read-only chat is shown from here, in place of the workspace's room, until
 * another room, the calendar or another workspace is opened.
 */
interface ArchiveViewState {
  room: Room | null;
  open: (room: Room) => void;
  close: () => void;
}

export const useArchiveView = create<ArchiveViewState>()((set) => ({
  room: null,
  open: (room) => {
    set({ room });
    useUi.getState().openDialog(null);
  },
  close: () => set({ room: null }),
}));

// Navigating anywhere closes it (a room, the day view, another workspace).
useUi.subscribe((s, prev) => {
  if (!useArchiveView.getState().room) return;
  if (s.lastRoom !== prev.lastRoom || s.activeWorkspaceId !== prev.activeWorkspaceId || (s.calDay && !prev.calDay)) useArchiveView.getState().close();
});
