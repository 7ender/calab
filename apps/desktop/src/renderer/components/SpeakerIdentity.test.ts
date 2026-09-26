import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Avatar's store / image imports pull in the platform layer (window); the row needs neither.
vi.mock('../stores/workspaces', () => ({ useWorkspaces: () => undefined }));
vi.mock('./MediaImg', () => ({ MediaImg: () => null }));
vi.mock('../platform', () => ({ platform: {} }));
import { SpeakerIdentity, speakerNameClass } from './SpeakerIdentity';

const render = (talking: boolean): string => renderToStaticMarkup(createElement(SpeakerIdentity, { userId: 'u-boris', name: 'Борис Петров', size: 32, talking, suffix: '(+2 UTC)' }));

describe('SpeakerIdentity (voice participant row)', () => {
  it('rings the avatar and brightens the name while talking', () => {
    const html = render(true);
    expect(html).toMatch(/data-speaking="true"[^>]*class="speak-ring/);
    expect(html).toMatch(/data-testid="speaker-name" class="[^"]*\btext-fg\b/);
    expect(html).not.toMatch(/data-testid="speaker-name" class="[^"]*\btext-muted\b/);
  });

  it('keeps the ring slot (no layout jump) and a muted name when silent', () => {
    const html = render(false);
    expect(html).not.toContain('data-speaking');
    expect(html).toContain('speak-ring'); // transparent outline: the ring never changes the size
    expect(html).toMatch(/data-testid="speaker-name" class="[^"]*\btext-muted\b/);
    expect(html).toContain('(+2 UTC)');
  });

  it('pending > 3 s: the connecting ring with «Подключается…» replaces the speaking ring', () => {
    const html = renderToStaticMarkup(createElement(SpeakerIdentity, { userId: 'u-g', name: 'Григорий', size: 32, talking: true, pending: true }));
    expect(html).toContain('data-testid="connect-ring"');
    expect(html).toContain('title="Подключается…"');
    expect(html).not.toContain('data-speaking');
    expect(html).toMatch(/data-testid="speaker-name" class="[^"]*\btext-muted\b/);
    expect(render(true)).not.toContain('connect-ring');
  });

  it('name class: primary while talking, muted (hover-bright) otherwise', () => {
    expect(speakerNameClass(true)).toBe('text-fg');
    expect(speakerNameClass(false)).toContain('text-muted');
  });
});
