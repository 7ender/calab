/**
 * Syntax highlighting of code blocks (docs/08, «Код в сообщениях»): Prism core (MIT, ~3 KB gz)
 * and its grammars are loaded lazily — the core with the first block that names a known language,
 * each grammar with the first block in it. Tokens become a small tree of classed runs rendered by
 * React (no HTML strings); colours come from theme tokens (app/styles.css, `.syn-*`).
 *
 * Tokenizing runs off the render path: in idle time, a few blocks per idle slice, and the result
 * is cached by (language, text), so a message re-rendered or scrolled back in highlights at once.
 */
import type { TokenStream } from 'prismjs';

type PrismApi = typeof import('prismjs');

/** A highlighted run: plain text or `[class, children]`. */
export type HlNode = string | { c: SynClass; v: HlNode[] };
export type SynClass = 'comment' | 'keyword' | 'string' | 'number' | 'fn' | 'type' | 'tag';

interface GrammarDef {
  deps?: string[];
  load: () => Promise<unknown>;
}

// One dynamic import per grammar: each becomes its own small chunk, fetched only when needed.
const GRAMMARS: Record<string, GrammarDef> = {
  clike: { load: () => import('prismjs/components/prism-clike') },
  markup: { load: () => import('prismjs/components/prism-markup') },
  css: { load: () => import('prismjs/components/prism-css') },
  javascript: { deps: ['clike'], load: () => import('prismjs/components/prism-javascript') },
  typescript: { deps: ['javascript'], load: () => import('prismjs/components/prism-typescript') },
  jsx: { deps: ['markup', 'javascript'], load: () => import('prismjs/components/prism-jsx') },
  tsx: { deps: ['jsx', 'typescript'], load: () => import('prismjs/components/prism-tsx') },
  go: { deps: ['clike'], load: () => import('prismjs/components/prism-go') },
  python: { load: () => import('prismjs/components/prism-python') },
  json: { load: () => import('prismjs/components/prism-json') },
  bash: { load: () => import('prismjs/components/prism-bash') },
  sql: { load: () => import('prismjs/components/prism-sql') },
  yaml: { load: () => import('prismjs/components/prism-yaml') },
  rust: { load: () => import('prismjs/components/prism-rust') },
  java: { deps: ['clike'], load: () => import('prismjs/components/prism-java') },
  c: { deps: ['clike'], load: () => import('prismjs/components/prism-c') },
  cpp: { deps: ['c'], load: () => import('prismjs/components/prism-cpp') },
  swift: { load: () => import('prismjs/components/prism-swift') },
  kotlin: { deps: ['clike'], load: () => import('prismjs/components/prism-kotlin') },
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  typescript: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  go: 'go',
  golang: 'go',
  py: 'python',
  python: 'python',
  json: 'json',
  jsonc: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  sql: 'sql',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  yaml: 'yaml',
  yml: 'yaml',
  rust: 'rust',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  kotlin: 'kotlin',
  kt: 'kotlin',
  kts: 'kotlin',
};

/** The grammar id for a block's language word, or undefined (unknown language: no highlighting). */
export function grammarId(lang: string): string | undefined {
  return ALIASES[lang.toLowerCase()];
}

/** Prism token types → our few colour classes; anything else is plain text. */
const CLASS_OF: Record<string, SynClass> = {
  comment: 'comment',
  prolog: 'comment',
  doctype: 'comment',
  cdata: 'comment',
  shebang: 'comment',
  keyword: 'keyword',
  boolean: 'keyword',
  important: 'keyword',
  atrule: 'keyword',
  rule: 'keyword',
  'null': 'keyword',
  string: 'string',
  char: 'string',
  'attr-value': 'string',
  regex: 'string',
  'template-string': 'string',
  'string-interpolation': 'string',
  url: 'string',
  number: 'number',
  constant: 'number',
  symbol: 'number',
  entity: 'number',
  function: 'fn',
  'function-definition': 'fn',
  'class-name': 'type',
  builtin: 'type',
  'maybe-class-name': 'type',
  tag: 'tag',
  selector: 'tag',
  property: 'tag',
  'attr-name': 'tag',
  key: 'tag',
  namespace: 'tag',
  variable: 'tag',
};

let prism: Promise<PrismApi> | undefined;
const loaded = new Map<string, Promise<void>>();

function loadCore(): Promise<PrismApi> {
  prism ??= (async () => {
    // Manual mode: Prism must not scan the page on load, nor listen for worker messages.
    const g = globalThis as { Prism?: Partial<PrismApi> };
    g.Prism = { manual: true, disableWorkerMessageHandler: true };
    const mod = (await import('prismjs/components/prism-core')) as { default?: PrismApi };
    return mod.default ?? (g.Prism as PrismApi);
  })();
  return prism;
}

function loadGrammar(id: string): Promise<void> {
  let p = loaded.get(id);
  if (!p) {
    const def = GRAMMARS[id];
    p = (async () => {
      await loadCore();
      if (!def) return;
      // Grammars extend their dependencies at load time: those go first, in order.
      for (const d of def.deps ?? []) await loadGrammar(d);
      await def.load();
    })();
    loaded.set(id, p);
  }
  return p;
}

function convert(stream: TokenStream, out: HlNode[]): void {
  if (typeof stream === 'string') {
    const last = out[out.length - 1];
    if (typeof last === 'string') out[out.length - 1] = last + stream;
    else out.push(stream);
    return;
  }
  if (Array.isArray(stream)) {
    for (const s of stream) convert(s, out);
    return;
  }
  const tok = stream;
  const aliases = Array.isArray(tok.alias) ? tok.alias : tok.alias ? [tok.alias] : [];
  const cls = CLASS_OF[tok.type] ?? aliases.map((a) => CLASS_OF[a]).find(Boolean);
  if (!cls) {
    convert(tok.content, out);
    return;
  }
  const v: HlNode[] = [];
  convert(tok.content, v);
  out.push({ c: cls, v });
}

/** Tokenize synchronously (the grammar must be loaded). Exported for tests. */
export function tokenize(api: PrismApi, code: string, id: string): HlNode[] | null {
  const grammar = api.languages[id];
  if (!grammar) return null;
  const out: HlNode[] = [];
  convert(api.tokenize(code, grammar), out);
  return out;
}

// ---- cache: (grammar, text) → runs; oldest out first (Map keeps insertion order)
const CACHE_MAX = 200;
const cache = new Map<string, HlNode[]>();
const keyOf = (code: string, id: string): string => `${id}\u0000${code}`;

/** Cached runs for this block, if it was highlighted before (render uses them at once; no side effects). */
export function cachedHighlight(code: string, id: string): HlNode[] | undefined {
  return cache.get(keyOf(code, id));
}

function remember(code: string, id: string, nodes: HlNode[]): void {
  cache.set(keyOf(code, id), nodes);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value ?? '');
}

// ---- idle queue: tokenizing never runs inside a React render or a scroll frame
type Job = () => void;
const queue: Job[] = [];
let scheduled = false;

interface IdleDeadlineLike {
  timeRemaining: () => number;
}

function idle(cb: (d: IdleDeadlineLike) => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadlineLike) => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(cb, { timeout: 1000 });
  else setTimeout(() => cb({ timeRemaining: () => 8 }), 16);
}

function drain(d: IdleDeadlineLike): void {
  scheduled = false;
  // At least one job per slice (a 1 s timeout fires with no time left), more while there is time.
  do queue.shift()?.();
  while (queue.length && d.timeRemaining() > 4);
  if (queue.length) schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  idle(drain);
}

/**
 * Highlight a block off the render path: loads the grammar, tokenizes in idle time, caches.
 * Resolves null when the language has no grammar or loading failed (the block stays plain).
 */
export async function highlightIdle(code: string, id: string): Promise<HlNode[] | null> {
  const hit = cachedHighlight(code, id);
  if (hit) return hit;
  try {
    await loadGrammar(id);
    const api = await loadCore();
    return await new Promise((resolve) => {
      queue.push(() => {
        const nodes = cachedHighlight(code, id) ?? tokenize(api, code, id);
        if (nodes) remember(code, id, nodes);
        resolve(nodes);
      });
      schedule();
    });
  } catch {
    return null;
  }
}

/** For tests: load a grammar and return the Prism API. */
export async function loadForTest(id: string): Promise<PrismApi> {
  await loadGrammar(id);
  return loadCore();
}
