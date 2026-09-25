import { describe, expect, it } from 'vitest';
import { parseMarkdown, toPlainText } from './parse';

describe('markdown-lite', () => {
  it('plain text stays text', () => {
    expect(parseMarkdown('привет мир')).toEqual([{ t: 'text', v: 'привет мир' }]);
  });

  it('bold, italic, strike, inline code', () => {
    expect(parseMarkdown('**a** *b* _c_ ~~d~~ `e*f*`')).toEqual([
      { t: 'b', c: [{ t: 'text', v: 'a' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 's', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'e*f*' },
    ]);
  });

  it('nested emphasis', () => {
    expect(parseMarkdown('**жирный *и курсив***')[0]).toEqual({
      t: 'b',
      c: [{ t: 'text', v: 'жирный ' }, { t: 'i', c: [{ t: 'text', v: 'и курсив' }] }],
    });
  });

  it('snake_case and lone stars are not emphasis', () => {
    expect(parseMarkdown('some_var_name and 2 * 3 * 4')).toEqual([{ t: 'text', v: 'some_var_name and 2 * 3 * 4' }]);
    expect(parseMarkdown('**unclosed')).toEqual([{ t: 'text', v: '**unclosed' }]);
  });

  it('code blocks keep content verbatim', () => {
    expect(parseMarkdown('до\n```ts\nconst a = **b**;\n```после')).toEqual([
      { t: 'text', v: 'до' },
      { t: 'br' },
      { t: 'codeblock', lang: 'ts', v: 'const a = **b**;' },
      { t: 'text', v: 'после' },
    ]);
  });

  it('links: markdown and bare, only http(s)', () => {
    expect(parseMarkdown('[сайт](https://ex.com/a) и https://ex.com/b.')).toEqual([
      { t: 'link', href: 'https://ex.com/a', c: [{ t: 'text', v: 'сайт' }] },
      { t: 'text', v: ' и ' },
      { t: 'link', href: 'https://ex.com/b', c: [{ t: 'text', v: 'https://ex.com/b' }] },
      { t: 'text', v: '.' },
    ]);
    expect(parseMarkdown('[x](javascript:alert(1))')).toEqual([{ t: 'text', v: '[x](javascript:alert(1))' }]);
  });

  it('HTML is just text', () => {
    expect(parseMarkdown('<b>hi</b><script>x</script>')).toEqual([{ t: 'text', v: '<b>hi</b><script>x</script>' }]);
  });

  it('mentions and escapes', () => {
    expect(parseMarkdown('привет @Аня, mail@x.io \\*не курсив\\*')).toEqual([
      { t: 'text', v: 'привет ' },
      { t: 'mention', v: 'Аня' },
      { t: 'text', v: ', mail@x.io *не курсив*' },
    ]);
  });

  it('plain-text preview', () => {
    expect(toPlainText(parseMarkdown('**a**\n`b` @c'))).toBe('a b @c');
  });
});
