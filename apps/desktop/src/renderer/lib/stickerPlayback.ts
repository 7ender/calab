/**
 * Playback budget of animated stickers (ADR-0030 §8, docs/14 «CPU»): an animated WebP plays
 * only while it is on screen, the window is shown and motion is allowed, and at most `max` of
 * them play at once — the ones that became visible first; the rest show their still first
 * frame. Pure state machine (the DOM glue is in features/chat/stickers/StickerImage.tsx).
 */
export interface Playback {
  /** Registers a sticker instance; `onChange(playing)` hears every change of its state. */
  add(id: number, onChange: (playing: boolean) => void): void;
  remove(id: number): void;
  setVisible(id: number, visible: boolean): void;
  /** Window shown and motion allowed (no prefers-reduced-motion). */
  setEnabled(enabled: boolean): void;
  isPlaying(id: number): boolean;
}

export const MAX_PLAYING = 6;

export function createPlayback(max = MAX_PLAYING): Playback {
  const listeners = new Map<number, (playing: boolean) => void>();
  // Visible instances in the order they became visible (Map keeps insertion order).
  const visible = new Map<number, true>();
  let playing = new Set<number>();
  let enabled = true;

  const recompute = (): void => {
    const next = new Set<number>();
    if (enabled) {
      for (const id of visible.keys()) {
        if (next.size >= max) break;
        next.add(id);
      }
    }
    const before = playing;
    playing = next;
    for (const id of before) if (!next.has(id)) listeners.get(id)?.(false);
    for (const id of next) if (!before.has(id)) listeners.get(id)?.(true);
  };

  return {
    add(id, onChange) {
      listeners.set(id, onChange);
    },
    remove(id) {
      listeners.delete(id);
      if (visible.delete(id)) recompute();
    },
    setVisible(id, v) {
      if (v === visible.has(id)) return;
      if (v) visible.set(id, true);
      else visible.delete(id);
      recompute();
    },
    setEnabled(v) {
      if (v === enabled) return;
      enabled = v;
      recompute();
    },
    isPlaying: (id) => playing.has(id),
  };
}
