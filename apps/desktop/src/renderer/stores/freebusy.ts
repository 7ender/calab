import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkHours } from '../lib/calendar/freebusy';
import type { BusyInterval, CalDavAccount, ExternalEvent } from '../lib/calendar/freebusyApi';
import { peopleReducer, type PeopleAction, type PeopleMap } from '../lib/calendar/people';

/**
 * Free / busy (ADR-0041 §3): people's busy time as the server answers it, per `<workspace>|<user>`
 * (their zone, work hours, busy intervals of the loaded 14-day windows), the day view's «Люди»
 * filter per workspace (kept in localStorage), the «Подобрать время» mode, my work hours and my
 * CalDAV account, my external events with their details (ADR-0045 §3). services/freebusy.ts fills it. Components select one person's entry (or a
 * primitive signature of a day of it) — never the whole map.
 */
export interface FbEntry {
  timezone: string;
  workHours: WorkHours;
  busy: readonly BusyInterval[];
}

/** «Подобрать время» in the day view (the dialog's own runs on local state). */
export interface FindState {
  workspaceId: string;
  users: readonly string[];
  durationMin: number;
  workHours: boolean;
}

interface FreeBusyState {
  entries: Readonly<Record<string, FbEntry>>;
  /** Loaded windows: `<workspace>|<user>|<chunk>` → true. */
  chunks: Readonly<Record<string, true>>;
  /** Bumped by every answer written (the suggestions ask again after a change). */
  rev: number;
  /** The day view's filter: workspace → selected user ids (≤ 20). */
  people: PeopleMap;
  /** «Только мои» over the day grid (docs/09 #140): workspace → on (kept in localStorage, off by default). */
  mine: Readonly<Record<string, true>>;
  find: FindState | null;
  /** undefined = not loaded; null = none. */
  caldav: CalDavAccount | null | undefined;
  /** No plan of mine includes CalDAV (Free): the account is kept, nothing syncs (ADR-0024, 30.09). */
  caldavLocked: boolean;
  /**
   * My external events by local day (`YYYY-MM-DD`; a day of a loaded window is there even when
   * empty), of `externalWs` (attendees are matched to its members) — cleared on a workspace or
   * account change.
   */
  external: Readonly<Record<string, readonly ExternalEvent[]>>;
  externalWs: string;
  /** Loaded (or loading) 14-day windows of `externalWs`. */
  externalChunks: Readonly<Record<number, true>>;
  dispatchPeople: (a: PeopleAction) => void;
  setMine: (workspaceId: string, on: boolean) => void;
  setFind: (f: FindState | null) => void;
  patchFind: (p: Partial<Omit<FindState, 'workspaceId'>>) => void;
  reset: () => void;
}

export const entryKey = (workspaceId: string, userId: string): string => `${workspaceId}|${userId}`;

export const useFreeBusy = create<FreeBusyState>()(
  persist(
    (set) => ({
      entries: {},
      chunks: {},
      rev: 0,
      people: {},
      mine: {},
      find: null,
      caldav: undefined,
      caldavLocked: false,
      external: {},
      externalWs: '',
      externalChunks: {},
      dispatchPeople: (a) => set((s) => {
        const people = peopleReducer(s.people, a);
        return people === s.people ? s : { people };
      }),
      setMine: (workspaceId, on) =>
        set((s) => {
          if (!!s.mine[workspaceId] === on) return s;
          const mine = { ...s.mine };
          if (on) mine[workspaceId] = true;
          else delete mine[workspaceId];
          return { mine };
        }),
      setFind: (find) => set({ find }),
      patchFind: (p) => set((s) => (s.find ? { find: { ...s.find, ...p } } : s)),
      reset: () => set({ entries: {}, chunks: {}, find: null, caldav: undefined, caldavLocked: false, external: {}, externalWs: '', externalChunks: {} }),
    }),
    {
      name: 'calaba-cal-people',
      version: 1,
      partialize: (s) => ({ people: s.people, mine: s.mine }),
    },
  ),
);

/** The day view's selection of a workspace (a stable empty list when none). */
const NONE: readonly string[] = [];
export const selectPeople = (workspaceId: string) => (s: FreeBusyState): readonly string[] => s.people[workspaceId] ?? NONE;

/** My external events of a day (a stable empty list when none / not loaded). */
const NO_EXTERNAL: readonly ExternalEvent[] = [];
export const selectExternalDay = (day: string) => (s: FreeBusyState): readonly ExternalEvent[] => s.external[day] ?? NO_EXTERNAL;

/** «Только мои» of a workspace. */
export const selectMine = (workspaceId: string) => (s: FreeBusyState): boolean => !!s.mine[workspaceId];
