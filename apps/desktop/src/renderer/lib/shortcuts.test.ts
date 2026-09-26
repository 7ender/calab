import { describe, expect, it } from 'vitest';
import { DEFAULT_HOTKEYS, comboFromEvent, comboLabel, comboProblem, effectiveHotkeys, matchesCombo, type Combo } from './shortcuts';

const ev = (code: string, key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  key,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe('in-window shortcuts', () => {
  it('captures a combo only with the primary modifier and a real key', () => {
    expect(comboFromEvent(ev('KeyJ', 'j', { meta: true, shift: true }), true)).toEqual({ code: 'KeyJ', shift: true, alt: false });
    expect(comboFromEvent(ev('KeyJ', 'j', { ctrl: true }), true)).toBeNull(); // Ctrl is not primary on macOS
    expect(comboFromEvent(ev('KeyJ', 'j', { ctrl: true }), false)).toEqual({ code: 'KeyJ', shift: false, alt: false });
    expect(comboFromEvent(ev('ShiftLeft', 'Shift', { meta: true, shift: true }), true)).toBeNull();
    expect(comboFromEvent(ev('KeyJ', 'j'), true)).toBeNull();
  });

  it('matches physical keys on any layout and Latin letters by key', () => {
    const m: Combo = DEFAULT_HOTKEYS.mute;
    expect(matchesCombo(ev('KeyM', 'ь', { meta: true, shift: true }), m, true)).toBe(true); // Russian layout
    expect(matchesCombo(ev('Semicolon', 'm', { meta: true, shift: true }), m, true)).toBe(true); // Dvorak-like
    expect(matchesCombo(ev('KeyM', 'm', { meta: true }), m, true)).toBe(false); // no shift
    expect(matchesCombo(ev('KeyM', 'm', { ctrl: true, shift: true }), m, false)).toBe(true);
  });

  it('labels per platform', () => {
    expect(comboLabel(DEFAULT_HOTKEYS.mute, true)).toBe('⌘⇧M');
    expect(comboLabel(DEFAULT_HOTKEYS.search, false)).toBe('Ctrl+K');
    expect(comboLabel({ code: 'Digit1', shift: false, alt: true }, true)).toBe('⌘⌥1');
    expect(comboLabel({ code: 'Slash', shift: true, alt: false }, false)).toBe('Ctrl+Shift+/');
  });

  it('rejects reserved system combos and conflicts, overrides merge with defaults', () => {
    const all = effectiveHotkeys({ search: { code: 'KeyP', shift: false, alt: false } });
    expect(all.search.code).toBe('KeyP');
    expect(all.mute).toEqual(DEFAULT_HOTKEYS.mute);
    expect(comboProblem('search', { code: 'KeyQ', shift: false, alt: false }, all)).toBe('reserved');
    expect(comboProblem('search', { code: 'KeyM', shift: false, alt: false }, all)).toBe('reserved'); // ⌘M minimise
    expect(comboProblem('search', { code: 'KeyM', shift: true, alt: false }, all)).toEqual({ conflict: 'mute' });
    expect(comboProblem('search', { code: 'KeyJ', shift: false, alt: false }, all)).toBeNull();
    expect(comboProblem('mute', { code: 'KeyQ', shift: false, alt: true }, all)).toBeNull(); // ⌘⌥Q is free
  });
});
