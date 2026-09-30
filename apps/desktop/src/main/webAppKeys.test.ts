import { describe, expect, it } from 'vitest';
import { navShortcut, type KeyInput } from './webAppKeys';

const k = (over: Partial<KeyInput>): KeyInput => ({ type: 'keyDown', key: 'r', meta: false, control: false, alt: false, shift: false, ...over });

describe('navShortcut', () => {
  it('maps ⌘[ ⌘] ⌘R on macOS', () => {
    expect(navShortcut(k({ key: '[', meta: true }), true)).toBe('back');
    expect(navShortcut(k({ key: ']', meta: true }), true)).toBe('forward');
    expect(navShortcut(k({ key: 'r', meta: true }), true)).toBe('reload');
  });
  it('maps Ctrl+[ ] R elsewhere', () => {
    expect(navShortcut(k({ key: '[', control: true }), false)).toBe('back');
    expect(navShortcut(k({ key: 'R', control: true }), false)).toBe('reload');
  });
  it('ignores the other platform modifier, shift/alt variants, key-up and plain keys', () => {
    expect(navShortcut(k({ key: 'r', control: true }), true)).toBeNull();
    expect(navShortcut(k({ key: 'r', meta: true }), false)).toBeNull();
    expect(navShortcut(k({ key: 'r', meta: true, shift: true }), true)).toBeNull();
    expect(navShortcut(k({ key: '[', meta: true, alt: true }), true)).toBeNull();
    expect(navShortcut(k({ key: 'r', meta: true, type: 'keyUp' }), true)).toBeNull();
    expect(navShortcut(k({ key: 'r' }), true)).toBeNull();
  });
});
