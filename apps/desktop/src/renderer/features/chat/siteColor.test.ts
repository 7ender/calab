import { describe, expect, it } from 'vitest';
import { SITE_COLORS, hostOf, siteColor, siteKey } from './siteColor';

describe('link preview site colour', () => {
  it('keys a site by its host (www and case ignored), else by the site name', () => {
    expect(siteKey('https://www.GitHub.com/a/b', 'GitHub')).toBe('github.com');
    expect(siteKey('https://github.com/c', '')).toBe('github.com');
    expect(siteKey('not a url', 'Calab Docs')).toBe('calab docs');
    expect(hostOf('https://docs.calaba.test/x?y')).toBe('docs.calaba.test');
  });

  it('is deterministic, from the token palette, and differs between sites', () => {
    const a = siteColor('github.com');
    expect(siteColor('github.com')).toBe(a);
    expect(SITE_COLORS).toContain(a);
    const colours = new Set(['github.com', 'calaba.test', 'youtube.com', 'habr.com', 'wikipedia.org', 'figma.com'].map(siteColor));
    expect(colours.size).toBeGreaterThan(1);
    for (const c of colours) expect(c).toMatch(/^var\(--name-[1-7]\)$/);
  });

  it('pages of one site share the colour', () => {
    expect(siteColor(siteKey('https://calaba.test/docs/08-design'))).toBe(siteColor(siteKey('https://calaba.test/board')));
  });
});
