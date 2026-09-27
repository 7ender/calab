import { describe, expect, it } from 'vitest';
import { systemLocales } from './systemLocales';

describe('systemLocales', () => {
  it('keeps Chromium locale first when it is an OS language', () => {
    expect(systemLocales('ru', ['ru-RU', 'en-US'], false)).toEqual(['ru', 'ru-RU', 'en-US']);
    expect(systemLocales('en-US', ['en-GB', 'ru-RU'], false)).toEqual(['en-US', 'en-GB', 'ru-RU']);
  });

  it('keeps --lang first', () => {
    expect(systemLocales('ru', ['de-DE'], true)).toEqual(['ru', 'de-DE']);
  });

  it('puts the en-US fallback (no UI pack for the OS language) after the OS list', () => {
    expect(systemLocales('en-US', ['de-DE', 'ru-RU'], false)).toEqual(['de-DE', 'ru-RU', 'en-US']);
    expect(systemLocales('en-US', ['uk-UA'], false)).toEqual(['uk-UA', 'en-US']);
  });

  it('uses Chromium locale when the OS list is empty', () => {
    expect(systemLocales('en-US', [], false)).toEqual(['en-US']);
  });
});
