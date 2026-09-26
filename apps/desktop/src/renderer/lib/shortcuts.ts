/**
 * Rebindable in-window shortcuts (docs/09 #18, «Горячие клавиши»). Pure: keys, labels,
 * matching and validation; services/hotkeys.ts listens, the settings page rebinds.
 *
 * A combo always includes the primary modifier (⌘ on macOS, Ctrl elsewhere) so it never fires
 * while typing. Keys are physical (`KeyboardEvent.code`), so they work on any layout
 * (review M8); for Latin letters `e.key` is also accepted (Dvorak/Colemak users keep their
 * letters).
 */
export type HotkeyAction = 'search' | 'mute' | 'deafen';

export interface Combo {
  /** KeyboardEvent.code, e.g. 'KeyK', 'Digit1', 'Slash'. */
  code: string;
  shift: boolean;
  alt: boolean;
}

export const HOTKEY_ACTIONS: HotkeyAction[] = ['search', 'mute', 'deafen'];

export const DEFAULT_HOTKEYS: Record<HotkeyAction, Combo> = {
  search: { code: 'KeyK', shift: false, alt: false },
  mute: { code: 'KeyM', shift: true, alt: false },
  deafen: { code: 'KeyD', shift: true, alt: false },
};

export function effectiveHotkeys(custom: Partial<Record<HotkeyAction, Combo>> | undefined): Record<HotkeyAction, Combo> {
  return { ...DEFAULT_HOTKEYS, ...(custom ?? {}) };
}

const MODIFIER_CODES = /^(Meta|Control|Shift|Alt|OS|CapsLock|Fn)/;

/** The combo of a key press, or null (no primary modifier, a lone modifier, Esc). */
export function comboFromEvent(e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, mac: boolean): Combo | null {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (!primary || !e.code || MODIFIER_CODES.test(e.code) || e.code === 'Escape') return null;
  return { code: e.code, shift: e.shiftKey, alt: e.altKey };
}

export function sameCombo(a: Combo, b: Combo): boolean {
  return a.code === b.code && a.shift === b.shift && a.alt === b.alt;
}

/** Does this key press trigger the combo? */
export function matchesCombo(e: Pick<KeyboardEvent, 'code' | 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>, c: Combo, mac: boolean): boolean {
  const primary = mac ? e.metaKey : e.ctrlKey;
  if (!primary || e.shiftKey !== c.shift || e.altKey !== c.alt) return false;
  if (e.code === c.code) return true;
  // Latin letter by `e.key` (keyboard layouts that move letters).
  const letter = /^Key([A-Z])$/.exec(c.code)?.[1];
  return !!letter && e.key.length === 1 && e.key.toUpperCase() === letter;
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: '↩',
  Backspace: '⌫',
  Tab: '⇥',
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

function keyName(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m?.[1]) return m[1];
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return KEY_NAMES[code] ?? code;
}

/** «⌘⇧M» on macOS, «Ctrl+Shift+M» elsewhere. */
export function comboLabel(c: Combo, mac: boolean): string {
  if (mac) return `⌘${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${keyName(c.code)}`;
  return `Ctrl+${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${keyName(c.code)}`;
}

/**
 * Combos the system or the app already uses: clipboard/undo/select-all, quit/close/hide/
 * minimise, the room-history keys, in-room search (⌘F), settings (⌘,), reload.
 */
const RESERVED: Array<{ code: string; shift?: boolean }> = [
  { code: 'KeyC' }, { code: 'KeyV' }, { code: 'KeyX' }, { code: 'KeyA' }, { code: 'KeyZ' }, { code: 'KeyZ', shift: true },
  { code: 'KeyQ' }, { code: 'KeyW' }, { code: 'KeyH' }, { code: 'KeyM' }, { code: 'KeyR' }, { code: 'KeyF' },
  { code: 'Comma' }, { code: 'BracketLeft' }, { code: 'BracketRight' },
];

export type ComboProblem = 'reserved' | { conflict: HotkeyAction };

export function comboProblem(action: HotkeyAction, c: Combo, all: Record<HotkeyAction, Combo>): ComboProblem | null {
  if (!c.alt && RESERVED.some((r) => r.code === c.code && !!r.shift === c.shift)) return 'reserved';
  for (const other of HOTKEY_ACTIONS) {
    if (other !== action && sameCombo(all[other], c)) return { conflict: other };
  }
  return null;
}
