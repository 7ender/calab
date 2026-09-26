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

/** «N/M» user limit indicator (docs/09 #31); empty when the room has no limit. */
export function limitLabel(n: number, max: number): string {
  return max > 0 ? `${n}/${max}` : '';
}

/** The two segments of the Discord-like `00 | 02` pill: people now, the limit; two digits each. */
export function limitSegments(n: number, max: number): [string, string] | null {
  if (max <= 0) return null;
  const pad = (v: number): string => String(Math.max(0, Math.min(99, Math.floor(v)))).padStart(2, '0');
  return [pad(n), pad(max)];
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
