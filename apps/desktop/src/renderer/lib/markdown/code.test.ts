import { describe, expect, it } from 'vitest';
import { clipLines, findFences, inCodeBlock, parseMarkdown, previewParts, toPlainText } from './parse';
import { grammarId, highlightIdle, loadForTest, tokenize, type HlNode } from './syntax';

describe('code blocks: parser', () => {
  it('language only when the fence line ends after it', () => {
    expect(parseMarkdown('```js\nconst a = 1;\n```')).toEqual([{ t: 'codeblock', lang: 'js', v: 'const a = 1;' }]);
    expect(parseMarkdown('```c++\nint x;```')).toEqual([{ t: 'codeblock', lang: 'c++', v: 'int x;' }]);
    // One line: everything is code, no language.
    expect(parseMarkdown('```hello world```')).toEqual([{ t: 'codeblock', lang: '', v: 'hello world' }]);
    expect(parseMarkdown('```\nplain\n```')).toEqual([{ t: 'codeblock', lang: '', v: 'plain' }]);
  });

  it('keeps indentation and blank lines verbatim', () => {
    expect(parseMarkdown('```py\ndef f():\n    return 1\n\n\tpass\n```')[0]).toEqual({ t: 'codeblock', lang: 'py', v: 'def f():\n    return 1\n\n\tpass' });
  });

  it('an unclosed fence on its own line runs to the end; a stray one is text', () => {
    expect(parseMarkdown('см.\n```go\nfunc main() {}')).toEqual([
      { t: 'text', v: 'см.' },
      { t: 'br' },
      { t: 'codeblock', lang: 'go', v: 'func main() {}' },
    ]);
    expect(findFences('```go\nx')[0]?.closed).toBe(false);
    expect(parseMarkdown('use ``` for code')).toEqual([{ t: 'text', v: 'use ``` for code' }]);
  });

  it('nested backticks: a longer fence wraps ```, spans of n close with n', () => {
    expect(parseMarkdown('````md\n```js\nx\n```\n````')).toEqual([{ t: 'codeblock', lang: 'md', v: '```js\nx\n```' }]);
    expect(parseMarkdown('``a`b`` и `c`')).toEqual([{ t: 'code', v: 'a`b' }, { t: 'text', v: ' и ' }, { t: 'code', v: 'c' }]);
    expect(parseMarkdown('`` `x` ``')).toEqual([{ t: 'code', v: '`x`' }]);
    expect(parseMarkdown('```js\nconst s = `t ${1}`;\n```')[0]).toEqual({ t: 'codeblock', lang: 'js', v: 'const s = `t ${1}`;' });
    expect(parseMarkdown('a ` b')).toEqual([{ t: 'text', v: 'a ` b' }]);
  });

  it('two blocks and text between', () => {
    const f = findFences('```a\n1\n```x```b\n2\n```');
    expect(f.map((x) => [x.lang, x.code])).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('clipLines: count and the first n lines', () => {
    expect(clipLines('a\nb\nc', 2)).toEqual({ lines: 3, head: 'a\nb' });
    expect(clipLines('a\nb', 2)).toEqual({ lines: 2, head: 'a\nb' });
    expect(clipLines('x', 400)).toEqual({ lines: 1, head: 'x' });
  });
});

describe('code blocks: composer Enter', () => {
  it('inside an unclosed block Enter is a new line; closing gives it back', () => {
    const t1 = '```js';
    expect(inCodeBlock(t1, t1.length)).toBe(true);
    const t2 = '```js\nconst a = 1;';
    expect(inCodeBlock(t2, t2.length)).toBe(true);
    const t3 = '```js\nconst a = 1;\n```';
    expect(inCodeBlock(t3, t3.length)).toBe(false);
    expect(inCodeBlock('привет', 6)).toBe(false);
    expect(inCodeBlock('`код`', 5)).toBe(false);
    // Caret inside a closed block (editing its middle) is inside the block too.
    expect(inCodeBlock(t3, 8)).toBe(true);
  });
});

describe('code blocks: previews', () => {
  it('a block is one monospace run without fences', () => {
    expect(previewParts(parseMarkdown('смотри:\n```js\nconst a = 1;\n  return a;\n```\nок'))).toEqual([
      { code: false, v: 'смотри: ' },
      { code: true, v: 'const a = 1; return a;' },
      { code: false, v: ' ок' },
    ]);
    expect(previewParts(parseMarkdown('a `b` c'))).toEqual([
      { code: false, v: 'a ' },
      { code: true, v: 'b' },
      { code: false, v: ' c' },
    ]);
    expect(toPlainText(parseMarkdown('x```\n1\n2\n```y'))).toBe('x 1 2 y');
  });

  it('max caps the total length', () => {
    expect(previewParts(parseMarkdown('ab`cdef`gh'), undefined, 4)).toEqual([
      { code: false, v: 'ab' },
      { code: true, v: 'cd' },
    ]);
  });
});

const flat = (ns: HlNode[]): string => ns.map((n) => (typeof n === 'string' ? n : flat(n.v))).join('');
const classes = (ns: HlNode[], out: string[] = []): string[] => {
  for (const n of ns) if (typeof n !== 'string') (out.push(n.c), classes(n.v, out));
  return out;
};

describe('code blocks: highlighting', () => {
  it('aliases map to grammars; unknown languages stay plain', () => {
    expect(grammarId('JS')).toBe('javascript');
    expect(grammarId('sh')).toBe('bash');
    expect(grammarId('c++')).toBe('cpp');
    expect(grammarId('brainfuck')).toBeUndefined();
    expect(grammarId('')).toBeUndefined();
  });

  it('tokenizes into classed runs that keep the text', async () => {
    const api = await loadForTest('tsx');
    const code = 'const a: number = 1; // hi\nfunction f() { return "s"; }';
    const nodes = tokenize(api, code, 'typescript');
    expect(nodes).not.toBeNull();
    expect(flat(nodes ?? [])).toBe(code);
    expect(new Set(classes(nodes ?? []))).toEqual(new Set(['keyword', 'number', 'comment', 'fn', 'string', 'type']));
    expect(tokenize(api, 'x', 'nope')).toBeNull();
  });

  it('highlightIdle loads the grammar lazily and caches the result', async () => {
    const a = await highlightIdle('package main\nfunc main() {}', 'go');
    expect(a && flat(a)).toBe('package main\nfunc main() {}');
    expect(await highlightIdle('package main\nfunc main() {}', 'go')).toBe(a);
  });
});
