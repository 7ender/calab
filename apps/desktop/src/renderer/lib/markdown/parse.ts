/**
 * markdown-lite: **bold**, *italic* / _italic_, ~~strike~~, `code`, ```code blocks```,
 * [text](https://…), bare http(s) links, mentions (@<user_id>, @everyone, @here), line breaks.
 * Produces an AST rendered by React (text is always escaped; no HTML is ever interpreted).
 */
export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'codeblock'; v: string; lang: string }
  | { t: 'b' | 'i' | 's'; c: MdNode[] }
  | { t: 'link'; href: string; c: MdNode[] }
  /** v: a lower-case user id, 'everyone' or 'here' (docs/05, «Упоминания»). */
  | { t: 'mention'; v: string }
  | { t: 'br' };

/**
 * Mirrors the server (apps/server/internal/messages/mentions.go): the token starts at a
 * non-word boundary ("mail@x" is not a mention) and ends at an ASCII word boundary.
 */
const MENTION_RE = /^@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|everyone|here)(?![A-Za-z0-9_])/i;
const MENTION_BLOCKER = /[\p{L}\p{N}_.@-]/u;
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

/** `before`: the character preceding `src` in the message (mention boundary of nested runs). */
export function parseInline(src: string, depth: number, before = ''): MdNode[] {
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
      buf += src[i + 1] ?? '';
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
        out.push({ t: 'link', href: m[2], c: depth < MAX_DEPTH ? parseInline(m[1], depth + 1, '[') : [{ t: 'text', v: m[1] }] });
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
    if (ch === '@' && !MENTION_BLOCKER.test((i ? src[i - 1] : before) || ' ')) {
      const m = MENTION_RE.exec(rest);
      if (m?.[1]) {
        flush();
        out.push({ t: 'mention', v: m[1].toLowerCase() });
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
            out.push({ t: d.t, c: parseInline(src.slice(i + d.open.length, close), depth + 1, d.open.slice(-1)) });
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

/** Plain-text preview (notifications, reply snippets); `mention` renders a mention (default `@<v>`). */
export function toPlainText(nodes: MdNode[], mention: (v: string) => string = (v) => `@${v}`): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
        case 'codeblock':
          return n.v;
        case 'mention':
          return mention(n.v);
        case 'br':
          return ' ';
        default:
          return toPlainText(n.c, mention);
      }
    })
    .join('');
}

/** Mentions of a message: user ids (lower case, unique) and whether it mentions everyone (@everyone / @here). */
export function mentionTargets(nodes: MdNode[]): { users: string[]; everyone: boolean } {
  const users = new Set<string>();
  let everyone = false;
  const walk = (ns: MdNode[]): void => {
    for (const n of ns) {
      if (n.t === 'mention') {
        if (n.v === 'everyone' || n.v === 'here') everyone = true;
        else users.add(n.v);
      } else if (n.t === 'b' || n.t === 'i' || n.t === 's' || n.t === 'link') walk(n.c);
    }
  };
  walk(nodes);
  return { users: [...users], everyone };
}

/** First http(s) link of a message (link preview candidate), or undefined. */
export function firstLink(nodes: MdNode[]): string | undefined {
  for (const n of nodes) {
    if (n.t === 'link') return n.href;
    if (n.t === 'b' || n.t === 'i' || n.t === 's') {
      const inner = firstLink(n.c);
      if (inner) return inner;
    }
  }
  return undefined;
}

/** True when the text is only 1–3 emoji (rendered large, without a bubble, like Telegram). */
export function isEmojiOnly(src: string): boolean {
  const s = src.trim();
  if (!s || s.length > 32) return false;
  const re = /^(?:\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;
  return re.test(s);
}
