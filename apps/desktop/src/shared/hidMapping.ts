/**
 * macOS `hidutil` UserKeyMapping helpers (pure; used by main/capsRemap.ts and tests).
 * Caps Lock → F18 remap = the Discord-on-macOS trick: F18 has a real press/release, so
 * Caps Lock becomes a true hold-to-talk key and stops toggling upper case.
 */
export interface KeyMapping {
  src: number;
  dst: number;
}

export const HID_CAPS_LOCK = 0x700000039;
export const HID_F18 = 0x70000006d;

/**
 * Parses `hidutil property --get UserKeyMapping`. The output has one row per HID service
 * (`<registryId> UserKeyMapping (…)` or `(null)`); the user mapping is the same on all of
 * them, so the first non-empty row wins.
 */
export function parseUserKeyMapping(out: string): KeyMapping[] {
  const sections = out.split(/\n(?=[0-9a-fA-F]+\s+UserKeyMapping\s)/);
  for (const sec of sections) {
    const blocks = sec.match(/\{[^}]*\}/g) ?? [];
    const pairs: KeyMapping[] = [];
    for (const b of blocks) {
      const src = /HIDKeyboardModifierMappingSrc\s*=\s*(\d+)/.exec(b)?.[1];
      const dst = /HIDKeyboardModifierMappingDst\s*=\s*(\d+)/.exec(b)?.[1];
      if (src && dst) pairs.push({ src: Number(src), dst: Number(dst) });
    }
    if (pairs.length > 0) return pairs;
  }
  return [];
}

/** The user's mappings plus ours (any existing mapping of Caps Lock is replaced). */
export function withCapsToF18(existing: KeyMapping[]): KeyMapping[] {
  return [...existing.filter((m) => m.src !== HID_CAPS_LOCK), { src: HID_CAPS_LOCK, dst: HID_F18 }];
}

/** JSON for `hidutil property --set` (hex literals are what hidutil documents; decimals work too). */
export function toHidutilJson(m: KeyMapping[]): string {
  return JSON.stringify({ UserKeyMapping: m.map((x) => ({ HIDKeyboardModifierMappingSrc: x.src, HIDKeyboardModifierMappingDst: x.dst })) });
}
