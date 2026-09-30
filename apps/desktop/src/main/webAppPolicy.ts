import { validateAppUrl } from '../shared/appUrl';

/**
 * The pure decisions of the web app views (ADR-0050 §4–§5), kept free of Electron so they are
 * unit-tested: what a site may ask for, where a navigation may go, what window.open opens, and
 * which views stay alive.
 */

// ---------------------------------------------------------------- permissions

/** A permission the user is asked about once per app (a Calab dialog); the answer is remembered. */
export type AskKind = 'camera' | 'microphone' | 'notifications' | 'geolocation' | 'clipboard-read';

export type PermissionDecision = { kind: 'allow' } | { kind: 'deny' } | { kind: 'ask'; ask: AskKind[] };

const ALLOW = { kind: 'allow' } as const;
const DENY = { kind: 'deny' } as const;

/**
 * setPermissionRequestHandler of an app session. Camera / microphone / notifications /
 * geolocation / clipboard-read are asked; a sanitized clipboard write (a «Copy» button) is
 * allowed as in any browser; everything else — HID, serial, USB, MIDI (sysex too), pointer lock,
 * full screen, screen capture, idle detection, window management, storage access, opening
 * external apps, protected media — is refused.
 */
export function permissionDecision(permission: string, mediaTypes: readonly string[] = []): PermissionDecision {
  switch (permission) {
    case 'media': {
      const ask: AskKind[] = [];
      if (mediaTypes.includes('video')) ask.push('camera');
      if (mediaTypes.includes('audio')) ask.push('microphone');
      // No media type named (an old enumerate path): refuse rather than grant both unseen.
      return ask.length ? { kind: 'ask', ask } : DENY;
    }
    case 'notifications':
      return { kind: 'ask', ask: ['notifications'] };
    case 'geolocation':
      return { kind: 'ask', ask: ['geolocation'] };
    case 'clipboard-read':
      return { kind: 'ask', ask: ['clipboard-read'] };
    case 'clipboard-sanitized-write':
      return ALLOW;
    default:
      return DENY;
  }
}

/** Remembered answers of one app: kind → granted. */
export type Remembered = Partial<Record<AskKind, boolean>>;

/**
 * setPermissionCheckHandler: a synchronous «is it granted?» — true only for what the request
 * handler would grant without asking (allow, or every asked kind remembered as granted).
 */
export function permissionCheck(permission: string, mediaType: string | undefined, remembered: Remembered): boolean {
  const d = permissionDecision(permission, mediaType ? [mediaType] : permission === 'media' ? ['audio', 'video'] : []);
  if (d.kind === 'allow') return true;
  if (d.kind === 'deny') return false;
  return d.ask.every((k) => remembered[k] === true);
}

/** What the request handler does with the remembered answers: grant, refuse, or ask about the rest. */
export function resolveWithRemembered(ask: readonly AskKind[], remembered: Remembered): { grant: true } | { grant: false } | { ask: AskKind[] } {
  if (ask.some((k) => remembered[k] === false)) return { grant: false };
  const open = ask.filter((k) => remembered[k] === undefined);
  return open.length ? { ask: open } : { grant: true };
}

// ---------------------------------------------------------------- navigation

/**
 * A top-level navigation inside a view (ADR-0050 §4): any https (sites go to SSO and back),
 * http only to a private host (the address rule, shared/appUrl.ts). Every other scheme — file:,
 * javascript:, data:, calab:, calaba-api:, custom app schemes — is refused. Unlike the saved
 * address, a navigation has no length limit (SAML / OAuth redirects carry long queries) and its
 * host is whatever Chromium resolved (underscores, punycode).
 */
export function mayNavigate(url: string): boolean {
  const m = /^(https?):\/\/([^/?#\\]*)/i.exec(url);
  const authority = (m?.[2] ?? '').slice((m?.[2] ?? '').lastIndexOf('@') + 1);
  if (!m || !authority) return false;
  if (m[1]?.toLowerCase() === 'https') return true;
  return validateAppUrl(`http://${authority}/`).ok;
}

/** The permission key of a page: its origin («https://meet.example.com:8443»); '' if not http(s). */
export function originOf(url: string): string {
  const m = /^(https?):\/\/(?:[^@/?#]*@)?([^/?#]+)/i.exec(url);
  return m ? `${(m[1] ?? '').toLowerCase()}://${(m[2] ?? '').toLowerCase()}` : '';
}

/**
 * A sub-frame navigation: web content only (an embedded player, a captcha…) — http(s), blob:,
 * data: (Chromium gives it an opaque origin) and about:blank / about:srcdoc; never file:,
 * javascript: or an app scheme.
 */
export function mayNavigateFrame(url: string): boolean {
  return /^(https?:|blob:|data:|about:(blank|srcdoc)$)/i.test(url);
}

// ---------------------------------------------------------------- window.open

export type OpenDecision = 'child' | 'external' | 'deny';

/**
 * window.open / target=_blank from a view (ADR-0050 §4):
 * - a popup (`disposition: new-window`, i.e. window.open with features — OAuth / SSO sign-in
 *   windows) or a page of the same site → a child window of Calab with the app's session and
 *   the same restrictions (`about:blank` popups too: sign-in scripts open one and navigate it);
 * - another site in a new tab → the system browser;
 * - any other scheme → refused.
 */
export function windowOpenDecision(openerUrl: string, url: string, disposition: string): OpenDecision {
  const popup = disposition === 'new-window';
  if (url === 'about:blank' || url === '') return popup ? 'child' : 'deny';
  if (!/^https?:\/\//i.test(url)) return 'deny';
  if (!mayNavigate(url)) return 'external';
  if (popup || sameSite(openerUrl, url)) return 'child';
  return 'external';
}

/** Two http(s) URLs of one site (registrable domain, approximated; IPs and single labels whole). */
export function sameSite(a: string, b: string): boolean {
  const sa = siteOf(a);
  return sa !== '' && sa === siteOf(b);
}

/** Second-level labels under which registrations are one level deeper (co.uk, com.ru, …). */
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'msk', 'spb']);

export function siteOf(url: string): string {
  const m = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  const host = (m?.[1] ?? '').toLowerCase().replace(/\.$/, '');
  if (!host || host.startsWith('[') || /^[0-9.]+$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1] ?? '';
  const sld = labels[labels.length - 2] ?? '';
  const keep = tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

// ---------------------------------------------------------------- LRU of live views

/** Views kept alive at most (ADR-0050 §5): the open app and the one before it. */
export const MAX_LIVE_VIEWS = 2;

/**
 * `id` becomes the most recent (first); returns the new order and the ids to destroy (beyond
 * `max`, least recent last).
 */
export function touchLru(order: readonly string[], id: string, max = MAX_LIVE_VIEWS): { order: string[]; evicted: string[] } {
  const next = [id, ...order.filter((x) => x !== id)];
  return { order: next.slice(0, max), evicted: next.slice(max) };
}

/** `id` is gone (deleted, crashed): the order without it. */
export function dropLru(order: readonly string[], id: string): string[] {
  return order.filter((x) => x !== id);
}

// ---------------------------------------------------------------- IPC arguments

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Validates renderer bounds (CSS px of the main window) and scales them to window DIPs. */
export function parseBounds(v: unknown, zoom = 1): ViewBounds {
  if (typeof v !== 'object' || v === null) throw new Error('invalid bounds');
  const r = v as Record<string, unknown>;
  const n = (k: string): number => {
    const x = r[k];
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 100_000) throw new Error('invalid bounds');
    return x;
  };
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return { x: Math.round(n('x') * z), y: Math.round(n('y') * z), width: Math.round(n('width') * z), height: Math.round(n('height') * z) };
}

/** An app id from the renderer: a UUID (it names the session partition `persist:app-<id>`). */
export function parseAppId(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error('invalid app id');
  return v.toLowerCase();
}

export const partitionOf = (appId: string): string => `persist:app-${appId}`;
