/**
 * The address rule of a workspace web app (ADR-0050 §1), shared by the renderer (the add / edit
 * dialog) and main (what a view may load and navigate to). The server runs the same rule
 * (apps/server/internal/workspaces/appurl.go); both are tested against
 * proto/testdata/app_urls.json. Parsed by hand, not with `new URL`, so that the two
 * implementations agree character by character (WHATWG parsing rewrites hosts: "0x7f.1" →
 * 127.0.0.1, punycode…).
 *
 * https:// to any host; http:// only to a private one — localhost (and *.localhost), 127/8,
 * [::1], 10/8, 172.16/12, 192.168/16, *.local, a single label without a dot (an intranet). No
 * user:password@, no whitespace, control characters or backslashes; a valid host and port;
 * at most 2048 characters.
 */

export const MAX_APP_URL_LENGTH = 2048;

export type AppUrlResult = { ok: true; url: string } | { ok: false };

const BAD = { ok: false } as const;

export function validateAppUrl(raw: string): AppUrlResult {
  const s = raw.trim();
  if (!s || codePoints(s) > MAX_APP_URL_LENGTH) return BAD;
  // Whitespace, control characters (C0, DEL, C1) and backslashes anywhere.
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\s\\\u0000-\u001f\u007f-\u009f]/u.test(s)) return BAD;
  const sep = s.indexOf('://');
  if (sep < 0) return BAD;
  const scheme = s.slice(0, sep).toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return BAD;
  const secure = scheme === 'https';
  const rest = s.slice(sep + 3);
  const end = rest.search(/[/?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  if (!authority || authority.includes('@')) return BAD;
  let host = authority;
  let port = '';
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return BAD;
    host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after) {
      if (!after.startsWith(':') || after.length === 1) return BAD;
      port = after.slice(1);
    }
  } else {
    const i = authority.lastIndexOf(':');
    if (i >= 0) {
      host = authority.slice(0, i);
      port = authority.slice(i + 1);
      if (!port) return BAD;
    }
  }
  if (port && !validPort(port)) return BAD;
  const h = checkHost(host.toLowerCase());
  if (!h.ok || (!secure && !h.private)) return BAD;
  return { ok: true, url: s };
}

/**
 * What the add dialog saves for a typed address: `https://` is put in front of an address
 * without a scheme («grafana.example.com» → «https://grafana.example.com»).
 */
export function withScheme(raw: string): string {
  const s = raw.trim();
  // A scheme is kept (a wrong one is then refused by validateAppUrl); «host:port» is not one.
  if (!s || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;
  return `https://${s}`;
}

/** The host of an address for the navigation strip («grafana.example.com»); '' if none. */
export function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  if (!m?.[1]) return '';
  const authority = m[1].slice(m[1].lastIndexOf('@') + 1);
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  const i = authority.lastIndexOf(':');
  return (i >= 0 ? authority.slice(0, i) : authority).toLowerCase();
}

/** Length in code points (the server counts runes; the DB counts characters). */
function codePoints(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // A high surrogate followed by a low one is one code point.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function validPort(p: string): boolean {
  if (p.length > 5 || !/^[0-9]+$/.test(p)) return false;
  const n = Number(p);
  return n >= 1 && n <= 65535;
}

function checkHost(host: string): { ok: boolean; private: boolean } {
  const no = { ok: false, private: false };
  if (host.startsWith('[')) {
    if (!host.endsWith(']')) return no;
    const inner = host.slice(1, -1);
    // IPv4-mapped / embedded IPv4 forms are refused (the server does: net.IP.To4 != nil).
    if (!isIPv6(inner) || inner.includes('.') || /^(0{0,4}:){0,5}:?ffff:/.test(inner)) return no;
    return { ok: true, private: isIPv6Loopback(inner) };
  }
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  if (!name || codePoints(name) > 253) return no;
  const labels = name.split('.');
  if (!labels.every(validLabel)) return no;
  // A numeric last label makes the whole host an IPv4 address to a browser (WHATWG): only the
  // canonical dotted quad is accepted.
  const last = labels[labels.length - 1] ?? '';
  if (/^[0-9]+$/.test(last) || last.startsWith('0x')) {
    const ip = dottedQuad(labels);
    if (!ip) return no;
    const [a, b] = ip;
    return { ok: true, private: a === 10 || a === 127 || (a === 172 && (b & 0xf0) === 16) || (a === 192 && b === 168) };
  }
  if (labels.length === 1 || last === 'localhost' || last === 'local') return { ok: true, private: true };
  return { ok: true, private: false };
}

function validLabel(l: string): boolean {
  const n = codePoints(l);
  if (n < 1 || n > 63 || l.startsWith('-') || l.endsWith('-')) return false;
  // ASCII letters, digits and '-', or letters / digits / marks of any script (an IDN typed as
  // is); the host is lower-cased already.
  return /^[a-z0-9\p{L}\p{Nd}\p{M}-]+$/u.test(l);
}

function dottedQuad(labels: string[]): [number, number, number, number] | null {
  if (labels.length !== 4) return null;
  const out: number[] = [];
  for (const l of labels) {
    if (!/^[0-9]{1,3}$/.test(l) || (l.length > 1 && l.startsWith('0'))) return null;
    const n = Number(l);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** A textual IPv6 address (hex groups, one «::», an optional trailing dotted quad). */
function isIPv6(s: string): boolean {
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return false;
  const halves = s.split('::');
  if (halves.length > 2) return false;
  const groups = (part: string): string[] | null => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !tail) return false;
  const all = [...head, ...tail];
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const g = all[i] ?? '';
    if (i === all.length - 1 && g.includes('.')) {
      if (!dottedQuad(g.split('.'))) return false;
      count += 2;
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
    count += 1;
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

function isIPv6Loopback(s: string): boolean {
  if (s === '::1') return true;
  const parts = s.split(':');
  return parts.length === 8 && parts.slice(0, 7).every((p) => /^0{1,4}$/.test(p)) && /^0{0,3}1$/.test(parts[7] ?? '');
}
