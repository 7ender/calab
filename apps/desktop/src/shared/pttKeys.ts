/**
 * Push-to-talk key codes and human-readable names (docs/02-media.md, «Push-to-talk»).
 *
 * Codes are libuiohook virtual key codes (what `uiohook-napi` reports in main) — not DOM
 * codes, so a binding survives keyboard layouts and works for keys the DOM never sees
 * (F13–F24, Caps Lock, side mouse buttons). Pure module: shared by main, renderer and tests.
 */

/** `process.platform` or 'web'. */
export type OsKind = string;

export const KEY = {
  CAPS_LOCK: 0x003a,
  /**
   * Calaba patch of libuiohook (patches/uiohook-napi@*.patch): on macOS a hardware Caps Lock
   * only reports a *lock state flip* (kCGEventFlagsChanged, once per press) — «pressed» when
   * the lock turns on, «released» when it turns off. It is a toggle, never a hold.
   */
  CAPS_LOCK_STATE: 0x0f3a,
  F18: 0x0065,
  ESCAPE: 0x0001,
} as const;

/** uiohook mouse buttons: 1 left, 2 right (never allowed as PTT), 3 middle, 4/5 side. */
export const MIN_MOUSE_BUTTON = 3;

const NAMES: Record<number, string> = {
  0x0001: 'Esc',
  0x000e: 'Backspace',
  0x000f: 'Tab',
  0x001c: 'Enter',
  0x0039: 'Space',
  0x003a: 'Caps Lock',
  0x0f3a: 'Caps Lock',
  0x0e49: 'Page Up',
  0x0e51: 'Page Down',
  0x0e4f: 'End',
  0x0e47: 'Home',
  0xe04b: '←',
  0xe048: '↑',
  0xe04d: '→',
  0xe050: '↓',
  0x0e52: 'Insert',
  0x0e53: 'Delete',
  0x0027: ';',
  0x000d: '=',
  0x0033: ',',
  0x000c: '-',
  0x0034: '.',
  0x0035: '/',
  0x0029: '`',
  0x001a: '[',
  0x002b: '\\',
  0x001b: ']',
  0x0028: "'",
  0x0045: 'Num Lock',
  0x0046: 'Scroll Lock',
  0x0e37: 'Print Screen',
  0x0e45: 'Pause',
  // Numpad
  0x0052: 'Num 0',
  0x004f: 'Num 1',
  0x0050: 'Num 2',
  0x0051: 'Num 3',
  0x004b: 'Num 4',
  0x004c: 'Num 5',
  0x004d: 'Num 6',
  0x0047: 'Num 7',
  0x0048: 'Num 8',
  0x0049: 'Num 9',
  0x0037: 'Num *',
  0x004e: 'Num +',
  0x004a: 'Num −',
  0x0053: 'Num .',
  0x0e35: 'Num /',
  0x0e1c: 'Num Enter',
  0xee4f: 'Num 1',
  0xee50: 'Num 2',
  0xee51: 'Num 3',
  0xee4b: 'Num 4',
  0xee4d: 'Num 6',
  0xee47: 'Num 7',
  0xee48: 'Num 8',
  0xee49: 'Num 9',
  0xee52: 'Num 0',
  0xee53: 'Num .',
};

const LETTERS: Record<number, string> = {
  30: 'A', 48: 'B', 46: 'C', 32: 'D', 18: 'E', 33: 'F', 34: 'G', 35: 'H', 23: 'I', 36: 'J', 37: 'K', 38: 'L', 50: 'M',
  49: 'N', 24: 'O', 25: 'P', 16: 'Q', 19: 'R', 31: 'S', 20: 'T', 22: 'U', 47: 'V', 17: 'W', 45: 'X', 21: 'Y', 44: 'Z',
  11: '0', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9',
};

const F_KEYS: Record<number, number> = {
  59: 1, 60: 2, 61: 3, 62: 4, 63: 5, 64: 6, 65: 7, 66: 8, 67: 9, 68: 10, 87: 11, 88: 12,
  91: 13, 92: 14, 93: 15, 99: 16, 100: 17, 101: 18, 102: 19, 103: 20, 104: 21, 105: 22, 106: 23, 107: 24,
};

/** Modifiers alone are valid PTT keys (like Discord); names follow the platform. */
function modifierName(code: number, os: OsKind): string | null {
  const mac = os === 'darwin';
  switch (code) {
    case 0x001d:
      return mac ? '⌃ Control' : 'Ctrl';
    case 0x0e1d:
      return mac ? 'Правый ⌃ Control' : 'Правый Ctrl';
    case 0x0038:
      return mac ? '⌥ Option' : 'Alt';
    case 0x0e38:
      return mac ? 'Правый ⌥ Option' : 'Правый Alt';
    case 0x002a:
      return mac ? '⇧ Shift' : 'Shift';
    case 0x0036:
      return mac ? 'Правый ⇧ Shift' : 'Правый Shift';
    case 0x0e5b:
      return mac ? '⌘ Command' : os === 'win32' ? 'Win' : 'Super';
    case 0x0e5c:
      return mac ? 'Правый ⌘ Command' : os === 'win32' ? 'Правый Win' : 'Правый Super';
    default:
      return null;
  }
}

export function keyName(code: number, os: OsKind): string {
  if (code === KEY.CAPS_LOCK || code === KEY.CAPS_LOCK_STATE) return '⇪ Caps Lock';
  const mod = modifierName(code, os);
  if (mod) return mod;
  const f = F_KEYS[code];
  if (f !== undefined) return `F${f}`;
  return LETTERS[code] ?? NAMES[code] ?? `Клавиша ${code}`;
}

export function mouseName(button: number): string {
  switch (button) {
    case 3:
      return 'Средняя кнопка мыши';
    case 4:
      return 'Кнопка мыши 4 (назад)';
    case 5:
      return 'Кнопка мыши 5 (вперёд)';
    default:
      return `Кнопка мыши ${button}`;
  }
}

/** A lock key reports lock-state flips, not a physical hold → it can only be a toggle. */
export function isToggleOnly(code: number): boolean {
  return code === KEY.CAPS_LOCK_STATE;
}

/** What main listens to for a key binding (`hid`: the macOS HID listener runs, shared/keySource.ts). */
export interface ResolvedKeyBinding {
  code: number;
  mode: 'hold' | 'toggle';
  /** The code reports lock-state flips (PttGate lockKey). */
  lockKey: boolean;
  /** Needs the hidutil Caps Lock → F18 remap (fallback without the HID listener). */
  remap: boolean;
}

/**
 * Bindings saved before the HID listener (≤ 0.2.1) keep working and use it when it runs: Caps Lock
 * remapped to F18 becomes the physical Caps Lock (no hidutil remap), and the lock-state toggle
 * becomes a toggle on the physical key — so a layout-switching Caps Lock works for both.
 */
export function resolveKeyBinding(b: { code: number; mode?: 'hold' | 'toggle'; remap?: 'caps-f18' }, hid: boolean): ResolvedKeyBinding {
  const mode = b.mode ?? 'hold';
  if (b.remap === 'caps-f18') {
    return hid ? { code: KEY.CAPS_LOCK, mode, lockKey: false, remap: false } : { code: b.code, mode, lockKey: false, remap: true };
  }
  if (isToggleOnly(b.code)) {
    return hid
      ? { code: KEY.CAPS_LOCK, mode: 'toggle', lockKey: false, remap: false }
      : { code: b.code, mode: 'toggle', lockKey: true, remap: false };
  }
  return { code: b.code, mode, lockKey: false, remap: false };
}
