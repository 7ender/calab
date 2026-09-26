/** Pure toast-stack logic (stores/toasts.ts): dedupe and cap. */

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: ToastAction;
  /** How many times the same toast was raised in a row («×3»). */
  count?: number;
}

/** At most this many toasts on screen; the oldest go first. */
export const TOAST_MAX = 4;

/**
 * An error toast is a sentence: it ends with a period unless it already ends with punctuation
 * («Не удалось загрузить сообщения. Проверьте интернет» → «… интернет.»).
 */
export function asSentence(text: string): string {
  const s = text.trimEnd();
  return s && /[\p{L}\p{N})»"]$/u.test(s) ? `${s}.` : s;
}

/** Sticky toasts are closed by the user only (an error with an action). */
export const isSticky = (x: Toast): boolean => x.kind === 'error' && x.action !== undefined;

/**
 * Adds a toast. The same text of the same kind as the newest toast is not stacked again: the
 * newest one is replaced (new id → its timer restarts) with a repeat counter. Over the cap the
 * oldest non-sticky toast is dropped first.
 */
export function pushToast(items: Toast[], next: Toast): Toast[] {
  if (next.kind === 'error') next = { ...next, text: asSentence(next.text) };
  const last = items[items.length - 1];
  let out = items;
  if (last && last.kind === next.kind && last.text === next.text) {
    out = items.slice(0, -1);
    next = { ...next, count: (last.count ?? 1) + 1 };
  }
  out = [...out, next];
  while (out.length > TOAST_MAX) {
    const i = out.findIndex((x) => !isSticky(x));
    out = out.filter((_, n) => n !== (i === -1 || i === out.length - 1 ? 0 : i));
  }
  return out;
}
