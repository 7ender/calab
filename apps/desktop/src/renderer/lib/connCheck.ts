/**
 * Settings → Соединение → «Проверить» (0.2.1): real checks of every path voice needs, not only the
 * API — API · RTC HTTPS · RTC WSS · TURN UDP · TURN TLS, each PASS/FAIL with milliseconds and the
 * error text. The verdict functions are pure (unit-tested); the probes below use browser APIs.
 *
 * - RTC HTTPS: `GET https://<rtc>/rtc/validate?access_token=<last join token>` (LiveKit's own
 *   reachability check; any HTTP answer = reachable, the status is shown).
 * - RTC WSS: a WebSocket handshake to `wss://<rtc>/rtc` without a token. LiveKit refuses it
 *   (HTTP 401 → close 1006), which still proves the TLS + upgrade path when HTTPS to the same
 *   host works; our CSP refusing it is reported as such (SecurityError / violation event).
 * - TURN: ICE gathering with `iceTransportPolicy: 'relay'` against the TURN servers LiveKit gave
 *   at the last join (UDP and TLS separately); a relay candidate = PASS.
 */
import { t } from '../i18n';

export type CheckId = 'api' | 'rtcHttps' | 'rtcWss' | 'turnUdp' | 'turnTls';
export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckRow {
  id: CheckId;
  status: CheckStatus;
  ms: number | null;
  detail: string | null;
}

export const CHECK_IDS: readonly CheckId[] = ['api', 'rtcHttps', 'rtcWss', 'turnUdp', 'turnTls'];
const WS_TIMEOUT_MS = 5000;
const ICE_TIMEOUT_MS = 8000;

// ------------------------------------------------------------------ pure verdicts

export interface HttpProbe {
  /** HTTP status; 0 for an opaque (no-cors) answer; null when no answer. */
  status: number | null;
  ms: number;
  error: string | null;
  cspBlocked: boolean;
}

export function httpRow(id: CheckId, p: HttpProbe): CheckRow {
  const ms = Math.round(p.ms);
  if (p.cspBlocked) return { id, status: 'fail', ms: null, detail: t('conn.d.cspBlocked') };
  if (p.status === null) return { id, status: 'fail', ms: null, detail: p.error ?? t('conn.checkFailed') };
  if (id === 'api' && (p.status < 200 || p.status >= 300)) return { id, status: 'fail', ms, detail: t('conn.d.http', { status: p.status }) };
  return { id, status: 'pass', ms, detail: p.status === 0 ? t('conn.d.opaque') : id === 'api' ? null : t('conn.d.http', { status: p.status }) };
}

export interface WsProbe {
  /** The WebSocket constructor threw (Chromium throws SecurityError for a CSP connect-src refusal). */
  thrown: string | null;
  opened: boolean;
  closeCode: number | null;
  ms: number;
  timedOut: boolean;
  cspBlocked: boolean;
}

/** `httpsOk`: HTTPS to the same host answered — a quick token-less refusal then means «reachable». */
export function wsRow(p: WsProbe, httpsOk: boolean): CheckRow {
  const ms = Math.round(p.ms);
  const id: CheckId = 'rtcWss';
  if (p.cspBlocked || (p.thrown && /security|content security|csp/i.test(p.thrown))) return { id, status: 'fail', ms: null, detail: t('conn.d.cspBlocked') };
  if (p.thrown) return { id, status: 'fail', ms: null, detail: p.thrown };
  if (p.opened) return { id, status: 'pass', ms, detail: t('conn.d.wsOpen') };
  if (p.timedOut) return { id, status: 'fail', ms: null, detail: t('conn.d.timeout', { s: WS_TIMEOUT_MS / 1000 }) };
  const code = p.closeCode ?? 1006;
  return httpsOk ? { id, status: 'pass', ms, detail: t('conn.d.wsRejected', { code }) } : { id, status: 'fail', ms, detail: t('conn.d.wsClosed', { code }) };
}

export interface IceError {
  url?: string;
  errorCode?: number;
  errorText?: string;
}

export interface IceProbe {
  /** ms to the first relay candidate; null = none. */
  relayMs: number | null;
  errors: IceError[];
  timedOut: boolean;
}

export function iceRow(id: 'turnUdp' | 'turnTls', servers: number, p: IceProbe | null): CheckRow {
  if (!p) return { id, status: 'skip', ms: null, detail: t('conn.d.noTurn') };
  if (servers === 0) return { id, status: 'skip', ms: null, detail: t('conn.d.noTurnKind') };
  if (p.relayMs !== null) return { id, status: 'pass', ms: Math.round(p.relayMs), detail: t('conn.d.relay') };
  const err = p.errors.find((e) => e.errorText || e.errorCode);
  const text = err ? [err.errorCode ? String(err.errorCode) : '', err.errorText ?? '', err.url ? `(${err.url})` : ''].filter(Boolean).join(' ') : null;
  if (text) return { id, status: 'fail', ms: null, detail: text };
  return { id, status: 'fail', ms: null, detail: p.timedOut ? t('conn.d.timeout', { s: ICE_TIMEOUT_MS / 1000 }) : t('conn.d.noRelay') };
}

/** TURN servers split by transport: `turn:` (UDP unless `transport=tcp`) and `turns:` (TLS). */
export function splitTurn(servers: readonly RTCIceServer[]): { udp: RTCIceServer[]; tls: RTCIceServer[] } {
  const udp: RTCIceServer[] = [];
  const tls: RTCIceServer[] = [];
  for (const s of servers) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    const u = urls.filter((x) => /^turn:/i.test(x) && !/transport=tcp/i.test(x));
    const tl = urls.filter((x) => /^turns:/i.test(x));
    if (u.length) udp.push({ ...s, urls: u });
    if (tl.length) tls.push({ ...s, urls: tl });
  }
  return { udp, tls };
}

/** A `candidate:` line's type (`typ relay`). */
export function candidateType(c: { type?: string | null; candidate?: string } | null): string | null {
  if (!c) return null;
  if (c.type) return c.type;
  return / typ (\w+)/.exec(c.candidate ?? '')?.[1] ?? null;
}

// ------------------------------------------------------------------ probes (browser)

export interface CheckInput {
  apiFetch: (path: string) => Promise<Response>;
  /** LiveKit URL + token of the last /join (null: never joined). */
  rtcUrl: string | null;
  token: string | null;
  iceServers: readonly RTCIceServer[];
}

const now = (): number => performance.now();
const message = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

async function probeHttp(fetcher: () => Promise<Response>, noCors: (() => Promise<Response>) | null): Promise<Omit<HttpProbe, 'cspBlocked'>> {
  const t0 = now();
  try {
    const r = await fetcher();
    return { status: r.status, ms: now() - t0, error: null };
  } catch (e) {
    if (noCors) {
      // CORS may be closed while the host is reachable: an opaque answer still proves the path.
      try {
        await noCors();
        return { status: 0, ms: now() - t0, error: null };
      } catch {
        // fall through with the first error
      }
    }
    return { status: null, ms: now() - t0, error: message(e) };
  }
}

function probeWs(url: string): Promise<Omit<WsProbe, 'cspBlocked'>> {
  const t0 = now();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    return Promise.resolve({ thrown: message(e), opened: false, closeCode: null, ms: 0, timedOut: false });
  }
  return new Promise((resolve) => {
    let opened = false;
    const finish = (r: Omit<WsProbe, 'cspBlocked'>): void => {
      clearTimeout(timer);
      ws.onopen = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ thrown: null, opened, closeCode: null, ms: now() - t0, timedOut: !opened }), WS_TIMEOUT_MS);
    ws.onopen = () => {
      opened = true;
      finish({ thrown: null, opened: true, closeCode: null, ms: now() - t0, timedOut: false });
    };
    ws.onclose = (ev) => finish({ thrown: null, opened, closeCode: ev.code, ms: now() - t0, timedOut: false });
  });
}

function probeIce(servers: RTCIceServer[]): Promise<IceProbe> {
  return new Promise((resolve) => {
    const errors: IceError[] = [];
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' });
    } catch (e) {
      resolve({ relayMs: null, errors: [{ errorText: message(e) }], timedOut: false });
      return;
    }
    const t0 = now();
    let done = false;
    const finish = (relayMs: number | null, timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve({ relayMs, errors, timedOut });
    };
    const timer = setTimeout(() => finish(null, true), ICE_TIMEOUT_MS);
    pc.onicecandidate = (e) => {
      if (!e.candidate) finish(null, false); // gathering complete without a relay
      else if (candidateType(e.candidate) === 'relay') finish(now() - t0, false);
    };
    pc.onicecandidateerror = (e) => {
      errors.push({ url: e.url, errorCode: e.errorCode, errorText: e.errorText });
    };
    pc.createDataChannel('probe');
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch((e: unknown) => {
        errors.push({ errorText: message(e) });
        finish(null, false);
      });
  });
}

function rtcHttpBase(rtcUrl: string): string {
  const u = new URL(rtcUrl);
  u.protocol = u.protocol === 'ws:' ? 'http:' : 'https:';
  return u.origin;
}

function rtcWsBase(rtcUrl: string): string {
  const u = new URL(rtcUrl);
  u.protocol = u.protocol === 'http:' || u.protocol === 'ws:' ? 'ws:' : 'wss:';
  return u.origin;
}

/** Runs the checks in order; `onRow` gets each row as soon as it is known. */
export async function runConnectionCheck(input: CheckInput, onRow: (row: CheckRow) => void): Promise<CheckRow[]> {
  const blocked = new Set<string>();
  const onViolation = (ev: SecurityPolicyViolationEvent): void => {
    try {
      blocked.add(new URL(ev.blockedURI).host);
    } catch {
      // not a URL (inline, eval)
    }
  };
  document.addEventListener('securitypolicyviolation', onViolation);
  const rows: CheckRow[] = [];
  const push = (r: CheckRow): void => {
    rows.push(r);
    onRow(r);
  };
  // Violation events are queued as tasks: let them arrive before a verdict.
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
  try {
    push(httpRow('api', { ...(await probeHttp(() => input.apiFetch('/api/me'), null)), cspBlocked: false }));

    let rtcHost: string | null = null;
    try {
      rtcHost = input.rtcUrl ? new URL(input.rtcUrl).host : null;
    } catch {
      rtcHost = null;
    }
    if (!input.rtcUrl || !rtcHost) {
      push({ id: 'rtcHttps', status: 'skip', ms: null, detail: t('conn.d.noRtc') });
      push({ id: 'rtcWss', status: 'skip', ms: null, detail: t('conn.d.noRtc') });
    } else {
      const base = rtcHttpBase(input.rtcUrl);
      const validate = `${base}/rtc/validate${input.token ? `?access_token=${encodeURIComponent(input.token)}` : ''}`;
      const http = await probeHttp(
        () => fetch(validate, { cache: 'no-store' }),
        () => fetch(`${base}/`, { mode: 'no-cors', cache: 'no-store' }),
      );
      await settle();
      const https = httpRow('rtcHttps', { ...http, cspBlocked: http.status === null && blocked.has(rtcHost) });
      push(https);
      const ws = await probeWs(`${rtcWsBase(input.rtcUrl)}/rtc`);
      await settle();
      push(wsRow({ ...ws, cspBlocked: !ws.opened && blocked.has(rtcHost) }, https.status === 'pass'));
    }

    const known = input.iceServers.length > 0;
    const { udp, tls } = splitTurn(input.iceServers);
    push(iceRow('turnUdp', udp.length, known && udp.length ? await probeIce(udp) : known ? { relayMs: null, errors: [], timedOut: false } : null));
    push(iceRow('turnTls', tls.length, known && tls.length ? await probeIce(tls) : known ? { relayMs: null, errors: [], timedOut: false } : null));
  } finally {
    document.removeEventListener('securitypolicyviolation', onViolation);
  }
  return rows;
}
