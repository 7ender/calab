/**
 * Autosave of the private note in the profile (docs/09 #20): every edit restarts an 800 ms
 * debounce, then one PUT; one save in flight at a time (a later edit is saved after it, so the
 * server never ends up with an older text); `flush()` saves at once (blur, closing the dialog).
 * Pure: the timer and the request are injected (unit-tested with fake timers).
 */

export const NOTE_DEBOUNCE_MS = 800;
export const NOTE_MAX = 1000;

export type NoteSaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface NoteSaver {
  /** The text in the editor changed. */
  change(text: string): void;
  /** Save now if the text differs from the saved one (blur, close). */
  flush(): Promise<void>;
  /** Stop the timer (the editor is gone; call flush() first to keep the edit). */
  dispose(): void;
  readonly state: NoteSaveState;
}

export function createNoteSaver(opts: {
  /** The note as loaded from the server. */
  initial: string;
  /** PUT the text; resolves with the stored text (trimmed by the server). */
  save: (text: string) => Promise<string>;
  delay?: number;
  onState?: (s: NoteSaveState) => void;
}): NoteSaver {
  const delay = opts.delay ?? NOTE_DEBOUNCE_MS;
  let saved = opts.initial.trim();
  let latest = opts.initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let state: NoteSaveState = 'idle';
  const set = (s: NoteSaveState): void => {
    if (s === state) return;
    state = s;
    opts.onState?.(s);
  };
  const dirty = (): boolean => latest.trim() !== saved;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const run = async (): Promise<void> => {
    clear();
    while (inFlight) await inFlight; // then save whatever is newest
    if (!dirty()) return;
    const text = latest.trim().slice(0, NOTE_MAX);
    set('saving');
    const p = opts.save(text).then(
      (stored) => {
        saved = stored;
        if (latest.trim() === text) latest = stored;
        set(dirty() ? 'pending' : 'saved');
      },
      () => set('error'),
    );
    inFlight = p;
    await p;
    inFlight = null;
    // Edited while that save was in flight: the timer (or flush) takes it from here.
    if (dirty() && state !== 'error' && timer === null) timer = setTimeout(() => void run(), delay);
  };

  return {
    change(text) {
      latest = text;
      clear();
      if (!dirty()) {
        if (!inFlight) set(state === 'error' || state === 'pending' ? 'idle' : state);
        return;
      }
      set('pending');
      timer = setTimeout(() => void run(), delay);
    },
    flush: run,
    dispose: clear,
    get state() {
      return state;
    },
  };
}
