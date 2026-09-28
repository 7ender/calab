import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PasswordInput, passwordToggle } from './ui';

const html = (visible: boolean): string =>
  renderToStaticMarkup(createElement(PasswordInput, { visible, autoComplete: 'current-password', name: 'password', defaultValue: 'secret' }));

describe('PasswordInput (docs/09 #75)', () => {
  it('toggles the input type, label and pressed state', () => {
    expect(passwordToggle(false)).toEqual({ type: 'password', label: 'Показать пароль', pressed: false });
    expect(passwordToggle(true)).toEqual({ type: 'text', label: 'Скрыть пароль', pressed: true });
  });

  it('hidden: a password input and an unpressed «Показать пароль» eye', () => {
    const h = html(false);
    expect(h).toContain('type="password"');
    expect(h).toContain('aria-label="Показать пароль"');
    expect(h).toContain('aria-pressed="false"');
    expect(h).toContain('lucide-eye');
    expect(h).not.toContain('lucide-eye-off');
  });

  it('shown: a text input and a pressed «Скрыть пароль» eye', () => {
    const h = html(true);
    expect(h).toContain('type="text"');
    expect(h).toContain('aria-label="Скрыть пароль"');
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain('lucide-eye-off');
  });

  it('keeps autofill and form submission: autocomplete/name stay, the eye is not a submit button, the input comes first', () => {
    const h = html(false);
    expect(h).toContain('autoComplete="current-password"');
    expect(h).toContain('name="password"');
    expect(h).toContain('type="button"');
    expect(h.indexOf('<input')).toBeLessThan(h.indexOf('<button'));
  });
});
