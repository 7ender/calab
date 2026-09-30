import { describe, expect, it } from 'vitest';
import { appDropAt, appInitial, coversContent, moveApp, type OverlayNode } from './webApps';

describe('appInitial', () => {
  it('takes the first letter or digit', () => {
    expect(appInitial('grafana')).toBe('G');
    expect(appInitial('  «вики»')).toBe('В');
    expect(appInitial('1С')).toBe('1');
    expect(appInitial('—')).toBe('?');
  });
});

describe('appDropAt', () => {
  const slots = [
    { id: 'a', top: 0, bottom: 32 },
    { id: 'b', top: 40, bottom: 72 },
    { id: 'c', top: 80, bottom: 112 },
  ];
  it('finds the insertion index among the others', () => {
    expect(appDropAt(slots, 5, 'c')).toEqual({ index: 0, lineY: -2 });
    expect(appDropAt(slots, 50, 'c')).toEqual({ index: 1, lineY: 38 });
    expect(appDropAt(slots, 200, 'a')).toEqual({ index: 2, lineY: 114 });
  });
  it('is null on its own place or for an unknown id', () => {
    expect(appDropAt(slots, 20, 'a')).toBeNull();
    expect(appDropAt(slots, 50, 'a')).toBeNull();
    expect(appDropAt(slots, 50, 'x')).toBeNull();
  });
});

describe('moveApp', () => {
  it('returns the order and the neighbours for the server', () => {
    expect(moveApp(['a', 'b', 'c'], 'c', 0)).toEqual({ order: ['c', 'a', 'b'], after: '', before: 'a' });
    expect(moveApp(['a', 'b', 'c'], 'a', 1)).toEqual({ order: ['b', 'a', 'c'], after: 'b', before: 'c' });
    expect(moveApp(['a', 'b', 'c'], 'a', 2)).toEqual({ order: ['b', 'c', 'a'], after: 'c', before: '' });
    expect(moveApp(['a', 'b'], 'a', 9)).toEqual({ order: ['b', 'a'], after: 'b', before: '' });
  });
});

function node(attrs: Record<string, string>, inner: string[] = []): OverlayNode {
  return {
    getAttribute: (n) => attrs[n] ?? null,
    hasAttribute: (n) => n in attrs,
    querySelector: (sel) => (sel.split(',').some((s) => inner.includes(s.trim())) ? {} : null),
  };
}

describe('coversContent (overlays hide the native view)', () => {
  it('menus, popovers and dialogs cover; tooltips do not', () => {
    expect(coversContent(node({ 'data-radix-popper-content-wrapper': '' }))).toBe(true);
    expect(coversContent(node({ 'data-radix-popper-content-wrapper': '' }, ['[role="tooltip"]']))).toBe(false);
    expect(coversContent(node({ role: 'dialog' }))).toBe(true);
    expect(coversContent(node({ role: 'alertdialog' }))).toBe(true);
    expect(coversContent(node({}, ['[role="dialog"]']))).toBe(true);
    expect(coversContent(node({ id: 'toasts' }))).toBe(false);
  });
});
