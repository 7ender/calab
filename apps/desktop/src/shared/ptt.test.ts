import { describe, expect, it } from 'vitest';
import { PttGate } from './pttGate';
import { KEY, isToggleOnly, keyName, mouseName } from './pttKeys';

describe('keyName', () => {
  it('names Caps Lock (both the key and the macOS lock-state code)', () => {
    expect(keyName(KEY.CAPS_LOCK, 'darwin')).toBe('⇪ Caps Lock');
    expect(keyName(KEY.CAPS_LOCK_STATE, 'darwin')).toBe('⇪ Caps Lock');
    expect(keyName(KEY.CAPS_LOCK, 'win32')).toBe('⇪ Caps Lock');
  });
  it('names function keys up to F24', () => {
    expect(keyName(59, 'darwin')).toBe('F1');
    expect(keyName(91, 'win32')).toBe('F13');
    expect(keyName(KEY.F18, 'darwin')).toBe('F18');
    expect(keyName(107, 'linux')).toBe('F24');
  });
  it('names lone modifiers per platform', () => {
    expect(keyName(0x0e5b, 'darwin')).toBe('⌘ Command');
    expect(keyName(0x0e5b, 'win32')).toBe('Win');
    expect(keyName(0x0038, 'darwin')).toBe('⌥ Option');
    expect(keyName(0x0038, 'win32')).toBe('Alt');
    expect(keyName(0x0e1d, 'linux')).toBe('Правый Ctrl');
  });
  it('names letters, numpad and unknown codes', () => {
    expect(keyName(30, 'darwin')).toBe('A');
    expect(keyName(0x0052, 'win32')).toBe('Num 0');
    expect(keyName(0x0e1c, 'win32')).toBe('Num Enter');
    expect(keyName(0x7777, 'win32')).toBe('Клавиша 30583');
  });
  it('names mouse buttons', () => {
    expect(mouseName(3)).toBe('Средняя кнопка мыши');
    expect(mouseName(4)).toBe('Кнопка мыши 4 (назад)');
    expect(mouseName(5)).toBe('Кнопка мыши 5 (вперёд)');
    expect(mouseName(7)).toBe('Кнопка мыши 7');
  });
  it('only the lock-state code is toggle-only', () => {
    expect(isToggleOnly(KEY.CAPS_LOCK_STATE)).toBe(true);
    expect(isToggleOnly(KEY.CAPS_LOCK)).toBe(false);
    expect(isToggleOnly(KEY.F18)).toBe(false);
  });
});

function run(gate: PttGate, events: boolean[]): boolean[] {
  return events.map((e) => {
    gate.input(e);
    return gate.isTalking;
  });
}

describe('PttGate', () => {
  it('hold: talks while down, swallows auto-repeat', () => {
    const changes: boolean[] = [];
    const g = new PttGate('hold', false, (v) => changes.push(v));
    expect(run(g, [true, true, true, false, false, true, false])).toEqual([true, true, true, false, false, true, false]);
    expect(changes).toEqual([true, false, true, false]);
  });
  it('toggle on a normal key: flips on the down edge only', () => {
    const g = new PttGate('toggle');
    expect(run(g, [true, true, false, true, false, true, false])).toEqual([true, true, true, false, false, true, true]);
  });
  it('lock key (macOS Caps Lock): every lock flip is a press', () => {
    const g = new PttGate('toggle', true);
    // lock on → talk, lock off → silent, lock on → talk
    expect(run(g, [true, false, true])).toEqual([true, false, true]);
  });
  it('lock key already on at start: the first «up» is still a press', () => {
    const g = new PttGate('toggle', true);
    expect(run(g, [false, true])).toEqual([true, false]);
  });
  it('lock key: a duplicated state is ignored', () => {
    const g = new PttGate('toggle', true);
    expect(run(g, [true, true, false])).toEqual([true, true, false]);
  });
  it('reset stops talking and forgets the lock state', () => {
    const changes: boolean[] = [];
    const g = new PttGate('toggle', true, (v) => changes.push(v));
    g.input(true);
    g.reset();
    expect(g.isTalking).toBe(false);
    g.input(true);
    expect(g.isTalking).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });
});

describe('hidutil mapping', async () => {
  const { parseUserKeyMapping, withCapsToF18, toHidutilJson, HID_CAPS_LOCK, HID_F18 } = await import('./hidMapping');
  const sample = `RegistryID  Key                   Value
100000928   UserKeyMapping   (
        {
        HIDKeyboardModifierMappingDst = 30064771181;
        HIDKeyboardModifierMappingSrc = 30064771129;
    },
        {
        HIDKeyboardModifierMappingDst = 30064771300;
        HIDKeyboardModifierMappingSrc = 30064771299;
    }
)
1000005e1   UserKeyMapping   (null)`;
  it('parses the first non-empty service', () => {
    expect(parseUserKeyMapping(sample)).toEqual([
      { src: 30064771129, dst: 30064771181 },
      { src: 30064771299, dst: 30064771300 },
    ]);
  });
  it('parses empty / null output as no mappings', () => {
    expect(parseUserKeyMapping('RegistryID  Key  Value\n100000928   UserKeyMapping   (null)')).toEqual([]);
    expect(parseUserKeyMapping('RegistryID  Key  Value\n100000928   UserKeyMapping   (\n)')).toEqual([]);
  });
  it('keeps the user mappings and replaces an existing Caps Lock mapping', () => {
    const user = [{ src: 0x700000064, dst: 0x700000035 }, { src: HID_CAPS_LOCK, dst: 0x7000000e0 }];
    expect(withCapsToF18(user)).toEqual([{ src: 0x700000064, dst: 0x700000035 }, { src: HID_CAPS_LOCK, dst: HID_F18 }]);
    expect(HID_CAPS_LOCK).toBe(30064771129);
    expect(HID_F18).toBe(30064771181);
  });
  it('serialises for hidutil --set', () => {
    expect(toHidutilJson([])).toBe('{"UserKeyMapping":[]}');
    expect(JSON.parse(toHidutilJson(withCapsToF18([])))).toEqual({
      UserKeyMapping: [{ HIDKeyboardModifierMappingSrc: HID_CAPS_LOCK, HIDKeyboardModifierMappingDst: HID_F18 }],
    });
  });
});
