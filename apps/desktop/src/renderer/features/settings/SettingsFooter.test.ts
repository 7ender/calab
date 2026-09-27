import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsFooter } from './SettingsFooter';

const html = (superadmin: boolean): string =>
  renderToStaticMarkup(createElement(SettingsFooter, { superadmin, onAdmin: () => undefined, onLogout: () => undefined }));

describe('settings sidebar footer (ADR-0024)', () => {
  it('superadmin: «Администрирование» with a shield above «Выйти»', () => {
    const h = html(true);
    expect(h).toContain('Администрирование');
    expect(h).toContain('lucide-shield-check');
    expect(h.indexOf('Администрирование')).toBeLessThan(h.indexOf('Выйти'));
  });

  it('everyone else: only «Выйти»', () => {
    const h = html(false);
    expect(h).not.toContain('Администрирование');
    expect(h).toContain('Выйти');
  });
});
