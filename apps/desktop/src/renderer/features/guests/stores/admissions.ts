import type { RoomAdmission } from '@calaba/protocol';
import { create } from 'zustand';
import { EMPTY, focusKnock, reduce, type AdmissionAction, type AdmissionsData, type MyKnock } from '../admissionsModel';

/**
 * Guest admission state (ADR-0040): one store, updated through the pure reducer
 * (admissionsModel.ts). Selectors stay narrow — a count or a list of one room by id, one knock by
 * key — so a knock on one room re-renders that room's row and group only.
 */
interface AdmissionsState extends AdmissionsData {
  dispatch: (act: AdmissionAction) => void;
}

export const useAdmissions = create<AdmissionsState>()((set) => ({
  ...EMPTY,
  dispatch: (act) =>
    set((s) => {
      const next = reduce(s, act);
      return next === s ? s : next;
    }),
}));

export const admissions = (act: AdmissionAction): void => useAdmissions.getState().dispatch(act);

const NONE: RoomAdmission[] = [];

/** Pending knocks of a room (deciders only receive them). */
export const useRoomKnocks = (roomId: string | null | undefined): RoomAdmission[] => useAdmissions((s) => (roomId ? (s.byRoom[roomId] ?? NONE) : NONE));

/** How many wait for a room: the sidebar counter. */
export const useKnockCount = (roomId: string): number => useAdmissions((s) => s.byRoom[roomId]?.length ?? 0);

/** One knock (a row, a toast) by room and user. */
export const useKnock = (roomId: string, userId: string): RoomAdmission | undefined =>
  useAdmissions((s) => s.byRoom[roomId]?.find((a) => a.user?.id === userId));

/** The guest's knock on screen (the waiting screen), if any. */
export const useFocusKnock = (): MyKnock | null => useAdmissions((s) => focusKnock(s.mine));

/** Whether the waiting screen is up (the app root: a boolean, so it re-renders on show / hide only). */
export const useWaiting = (): boolean => useAdmissions((s) => focusKnock(s.mine) !== null);
