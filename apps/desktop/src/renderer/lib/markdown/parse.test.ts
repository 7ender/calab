import { describe, expect, it } from 'vitest';
import { firstLink, isEmojiOnly, mentionTargets, parseMarkdown, toPlainText } from './parse';

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

  const A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

  it('mentions: @<user_id>, @everyone, @here only', () => {
    expect(parseMarkdown(`привет @${A.toUpperCase()}, @everyone и @Here! @Аня`)).toEqual([
      { t: 'text', v: 'привет ' },
      { t: 'mention', v: A },
      { t: 'text', v: ', ' },
      { t: 'mention', v: 'everyone' },
      { t: 'text', v: ' и ' },
      { t: 'mention', v: 'here' },
      { t: 'text', v: '! @Аня' },
    ]);
  });

  it('mentions: boundary rule mirrors the server', () => {
    for (const s of [`mail@${A}`, `a.@here`, `x-@everyone`, `_@here`, `@@here`, `@everyones`, `@here_x`, `@${A}0`]) {
      expect(parseMarkdown(s).some((n) => n.t === 'mention'), s).toBe(false);
    }
    expect(parseMarkdown('(@here)')[1]).toEqual({ t: 'mention', v: 'here' });
    expect(parseMarkdown('**@here**')).toEqual([{ t: 'b', c: [{ t: 'mention', v: 'here' }] }]);
    expect(parseMarkdown('@hereЖ')[0]).toEqual({ t: 'mention', v: 'here' });
  });

  it('mentions: not inside code', () => {
    expect(parseMarkdown('`@here`')).toEqual([{ t: 'code', v: '@here' }]);
    expect(parseMarkdown('```\n@everyone\n```')).toEqual([{ t: 'codeblock', lang: '', v: '@everyone' }]);
  });

  it('mentionTargets', () => {
    expect(mentionTargets(parseMarkdown(`*@${A}* @${A} [@here](https://x.test) \`@everyone\``))).toEqual({ users: [A], everyone: true });
    expect(mentionTargets(parseMarkdown('нет упоминаний'))).toEqual({ users: [], everyone: false });
  });

  it('escapes', () => {
    expect(parseMarkdown('\\*не курсив\\*')).toEqual([{ t: 'text', v: '*не курсив*' }]);
  });

  it('plain-text preview', () => {
    expect(toPlainText(parseMarkdown('**a**\n`b` @here'))).toBe('a b @here');
    expect(toPlainText(parseMarkdown(`@${A} ок`), (v) => (v === A ? '@Аня' : `@${v}`))).toBe('@Аня ок');
  });

  it('firstLink finds bare, markdown and nested links', () => {
    expect(firstLink(parseMarkdown('см. https://a.test/x и https://b.test'))).toBe('https://a.test/x');
    expect(firstLink(parseMarkdown('**[док](https://c.test/d)**'))).toBe('https://c.test/d');
    expect(firstLink(parseMarkdown('`https://code.test` нет'))).toBeUndefined();
  });

  it('isEmojiOnly: 1–3 emoji only', () => {
    expect(isEmojiOnly('👍')).toBe(true);
    expect(isEmojiOnly('🔥 🔥')).toBe(true);
    expect(isEmojiOnly('❤️')).toBe(true);
    expect(isEmojiOnly('👍🏽')).toBe(true);
    expect(isEmojiOnly('👍 ок')).toBe(false);
    expect(isEmojiOnly('1')).toBe(false);
    expect(isEmojiOnly('😀😀😀😀')).toBe(false);
  });
});

