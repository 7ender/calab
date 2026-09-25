/**
 * markdown-lite: **bold**, *italic* / _italic_, ~~strike~~, `code`, ```code blocks```,
 * [text](https://…), bare http(s) links, @mentions, line breaks.
 * Produces an AST rendered by React (text is always escaped; no HTML is ever interpreted).
 */
export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'codeblock'; v: string; lang: string }
  | { t: 'b' | 'i' | 's'; c: MdNode[] }
  | { t: 'link'; href: string; c: MdNode[] }
  | { t: 'mention'; v: string }
  | { t: 'br' };

const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/;
const MAX_DEPTH = 8;

export function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function parseMarkdown(src: string): MdNode[] {
  const out: MdNode[] = [];
  // Code blocks first: their content is never parsed further.
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push(...parseInline(src.slice(last, m.index), 0));
    out.push({ t: 'codeblock', lang: m[1] ?? '', v: (m[2] ?? '').replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(...parseInline(src.slice(last), 0));
  return mergeText(out);
}

function mergeText(nodes: MdNode[]): MdNode[] {
  const res: MdNode[] = [];
  for (const n of nodes) {
    const prev = res[res.length - 1];
    if (n.t === 'text' && prev?.t === 'text') prev.v += n.v;
    else res.push(n);
  }
  return res;
}

interface Delim {
  open: string;
  t: 'b' | 'i' | 's';
}

const DELIMS: Delim[] = [
  { open: '**', t: 'b' },
  { open: '__', t: 'b' },
  { open: '~~', t: 's' },
  { open: '*', t: 'i' },
  { open: '_', t: 'i' },
];

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

export function parseInline(src: string, depth: number): MdNode[] {
  const out: MdNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    const rest = src.slice(i);

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()@]/.test(src[i + 1] ?? '')) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
      if (m && m[1] && m[2]) {
        flush();
        out.push({ t: 'link', href: m[2], c: depth < MAX_DEPTH ? parseInline(m[1], depth + 1) : [{ t: 'text', v: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === 'h' && !isWordChar(src[i - 1])) {
      const m = URL_RE.exec(rest);
      if (m) {
        flush();
        out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '@' && !isWordChar(src[i - 1])) {
      const m = /^@([\p{L}\p{N}_.-]{1,32})/u.exec(rest);
      if (m?.[1]) {
        flush();
        out.push({ t: 'mention', v: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      const d = DELIMS.find((x) => rest.startsWith(x.open));
      if (d) {
        // Intraword underscores (snake_case) are not emphasis.
        const intraword = d.open.startsWith('_') && isWordChar(src[i - 1]);
        const after = src[i + d.open.length];
        if (!intraword && after !== undefined && !/\s/.test(after)) {
          const close = findClose(src, i + d.open.length, d.open);
          if (close > 0) {
            flush();
            out.push({ t: d.t, c: parseInline(src.slice(i + d.open.length, close), depth + 1) });
            i = close + d.open.length;
            continue;
          }
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function findClose(src: string, from: number, delim: string): number {
  let j = src.indexOf(delim, from);
  while (j > from) {
    const before = src[j - 1];
    const afterClose = src[j + delim.length];
    const single = delim.length === 1;
    // "**" must not close a single "*"; the closer must follow a non-space.
    const doubled = single && (afterClose === delim || src[j - 1] === delim);
    const wordAfter = delim.startsWith('_') && isWordChar(afterClose);
    if (before !== undefined && !/\s/.test(before) && !doubled && !wordAfter) {
      // "***": the double closer takes the last two chars so the inner "*" can close italic.
      if (!single) while (src[j + delim.length] === delim[0]) j++;
      return j;
    }
    j = src.indexOf(delim, j + 1);
  }
  return -1;
}

/** Plain-text preview (notifications, reply snippets). */
export function toPlainText(nodes: MdNode[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
        case 'codeblock':
          return n.v;
        case 'mention':
          return `@${n.v}`;
        case 'br':
          return ' ';
        default:
          return toPlainText(n.c);
      }
    })
    .join('');
}
