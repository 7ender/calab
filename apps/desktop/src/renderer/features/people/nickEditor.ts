/**
 * Inline nickname editing in «Участники» (docs/09 #26): ✎ or a double click opens the field;
 * Enter or leaving the field saves (PATCH …/members/{userId} {nickname}, the one rename API),
 * Esc restores the name; a failed save keeps the field open with the error under it. Leaving the
 * field again with the same rejected text does not resend it (Enter does — an explicit retry).
 * Pure: the request is injected (unit-tested without a DOM).
 */

export const NICK_MAX = 64;

export type NickEditState =
  | { mode: 'view' }
  | { mode: 'edit'; value: string; saving: boolean; error: string | null };

export interface NickEditor {
  /** ✎ / double click: open the field with the current nickname. */
  start(): void;
  change(value: string): void;
  /** Enter (`retry`) or blur: save when changed; unchanged closes the field. */
  commit(how: 'enter' | 'blur'): Promise<void>;
  /** Esc: close without saving (ignored while a save is in flight). */
  cancel(): void;
  readonly state: NickEditState;
}

export function createNickEditor(opts: {
  /** The nickname as stored now ('' = the profile name is shown). */
  current: () => string;
  save: (nickname: string) => Promise<void>;
  errorText: (e: unknown) => string;
  onState?: (s: NickEditState) => void;
}): NickEditor {
  let state: NickEditState = { mode: 'view' };
  let rejected: string | null = null;
  const set = (s: NickEditState): void => {
    state = s;
    opts.onState?.(s);
  };
  return {
    get state() {
      return state;
    },
    start() {
      if (state.mode === 'edit') return;
      rejected = null;
      set({ mode: 'edit', value: opts.current(), saving: false, error: null });
    },
    change(value) {
      if (state.mode !== 'edit' || state.saving) return;
      set({ ...state, value: value.slice(0, NICK_MAX) });
    },
    async commit(how) {
      if (state.mode !== 'edit' || state.saving) return;
      const nick = state.value.trim();
      if (nick === opts.current().trim()) {
        set({ mode: 'view' });
        return;
      }
      if (how === 'blur' && nick === rejected) return;
      set({ ...state, saving: true, error: null });
      try {
        await opts.save(nick);
        rejected = null;
        set({ mode: 'view' });
      } catch (e) {
        rejected = nick;
        set({ mode: 'edit', value: state.value, saving: false, error: opts.errorText(e) });
      }
    },
    cancel() {
      if (state.mode !== 'edit' || state.saving) return;
      rejected = null;
      set({ mode: 'view' });
    },
  };
}
