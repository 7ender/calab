import { describe, expect, it } from 'vitest';
import { enterInsertsNewline, trimMessage } from './composerText';

describe('composer text', () => {
  it('Enter inside an unclosed ``` inserts a line, after the closing fence it sends', () => {
    let s = '```';
    expect(enterInsertsNewline(s, s.length)).toBe(true);
    s = '```ts\nconst a = 1;';
    expect(enterInsertsNewline(s, s.length)).toBe(true);
    s += '\n```';
    expect(enterInsertsNewline(s, s.length)).toBe(false);
    expect(enterInsertsNewline('hi', 2)).toBe(false);
  });

  it('keeps the indentation of pasted multi-line text', () => {
    expect(trimMessage('\n\n    if x:\n        y()\n\n')).toBe('    if x:\n        y()');
    expect(trimMessage('```py\n  a\n```  ')).toBe('```py\n  a\n```');
    expect(trimMessage('   привет  ')).toBe('привет');
    expect(trimMessage(' \n ')).toBe('');
  });
});
