import { inCodeBlock } from '../../lib/markdown/parse';

/**
 * Enter at `caret` adds a line instead of sending while the caret is inside a code block that is
 * not closed before it (```lang⏎… — docs/08, «Код в сообщениях»). Closing the fence brings the
 * usual Enter back.
 */
export function enterInsertsNewline(text: string, caret: number): boolean {
  return inCodeBlock(text, caret);
}

/**
 * The text to send: blank lines around it and trailing spaces go, but the indentation of a
 * multi-line message (pasted code) stays — only a one-line message loses its leading spaces.
 */
export function trimMessage(text: string): string {
  const s = text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  return s.includes('\n') ? s : s.trimStart();
}
