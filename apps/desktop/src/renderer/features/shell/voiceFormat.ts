import { useSyncExternalStore } from 'react';

/** Call duration for the room list: «4:05», «1:02:03» (hours only when needed). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The REC timer (docs/09 #30): time since the recording started, like the call timer. */
export function recordingTime(since: number, now: number): string {
  return formatDuration(now - since);
}

/** Zero-pads 0..99 for the two-segment room-limit pill (docs/09 #9): 0 → "00", 7 → "07", 42 → "42". */
export function pad2(n: number): string {
  return String(Math.max(0, Math.min(99, Math.trunc(n)))).padStart(2, '0');
}

/** The invite row is visible for 30 s after joining a voice room (docs/09 #10). */
export const INVITE_ROW_MS = 30_000;

/** Is the «Пригласить в комнату» row shown? Not while the room is full, only within the window,
 * and only when `joinedAt` is set (I am actually in this room). */
export function inviteRowVisible(joinedAt: number | null, now: number, full: boolean): boolean {
  return !full && joinedAt != null && now - joinedAt < INVITE_ROW_MS;
}

/** Parses the «Максимум участников» field: integer 0..99, anything else → null. */
export function parseUserLimit(v: string): number | null {
  const s = v.trim();
  if (s === '') return 0;
  if (!/^\d{1,2}$/.test(s)) return null;
  return Number(s);
}

// One shared 1 s ticker for every call timer on screen (no interval per row).
let now = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (timer === null) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (!listeners.size && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, re-rendering once a second while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
