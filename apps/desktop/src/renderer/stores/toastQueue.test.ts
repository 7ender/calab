import { describe, expect, it } from 'vitest';
import { TOAST_MAX, asSentence, isSticky, pushToast, type Toast } from './toastQueue';

const info = (id: number, text = `t${id}`): Toast => ({ id, kind: 'info', text });
const sticky = (id: number): Toast => ({ id, kind: 'error', text: `e${id}`, action: { label: 'Повторить', run: () => undefined } });

describe('pushToast', () => {
  it('appends', () => {
    expect(pushToast([info(1)], info(2)).map((x) => x.id)).toEqual([1, 2]);
  });

  it('collapses a repeat of the newest toast into a counter with a fresh id', () => {
    const a = pushToast([info(1, 'same')], info(2, 'same'));
    expect(a).toEqual([{ id: 2, kind: 'info', text: 'same', count: 2 }]);
    expect(pushToast(a, info(3, 'same'))[0]?.count).toBe(3);
  });

  it('does not collapse different kinds', () => {
    expect(pushToast([info(1, 'x')], { id: 2, kind: 'error', text: 'x' })).toHaveLength(2);
  });

  it('caps the stack, dropping the oldest non-sticky first', () => {
    let s: Toast[] = [sticky(1)];
    for (let i = 2; i <= TOAST_MAX + 2; i++) s = pushToast(s, info(i));
    expect(s).toHaveLength(TOAST_MAX);
    expect(s[0]?.id).toBe(1);
    expect(s[s.length - 1]?.id).toBe(TOAST_MAX + 2);
  });

  it('drops the oldest when everything is sticky, never the new one', () => {
    let s: Toast[] = [];
    for (let i = 1; i <= TOAST_MAX + 1; i++) s = pushToast(s, sticky(i));
    expect(s.map((x) => x.id)).toEqual([2, 3, 4, 5]);
  });

  it('knows sticky toasts', () => {
    expect(isSticky(sticky(1))).toBe(true);
    expect(isSticky({ id: 1, kind: 'error', text: 'x' })).toBe(false);
  });
});

describe('asSentence', () => {
  it('ends error texts with a period', () => {
    expect(asSentence('Проверьте интернет')).toBe('Проверьте интернет.');
    expect(asSentence('Нет доступа к «Переговорке»')).toBe('Нет доступа к «Переговорке».');
    expect(asSentence('Уже с точкой.')).toBe('Уже с точкой.');
    expect(asSentence('Что случилось?')).toBe('Что случилось?');
    expect(asSentence('')).toBe('');
  });
  it('is applied to error toasts only', () => {
    expect(pushToast([], { id: 1, kind: 'error', text: 'Сбой' })[0]?.text).toBe('Сбой.');
    expect(pushToast([], { id: 1, kind: 'info', text: 'Скопировано' })[0]?.text).toBe('Скопировано');
  });
});
