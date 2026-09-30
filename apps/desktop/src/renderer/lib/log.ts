import { platform } from '../platform';

/** Renderer logging → electron-log file in userData/logs (via main). */
export const log = {
  info: (...a: unknown[]): void => send('info', a),
  warn: (...a: unknown[]): void => send('warn', a),
  error: (...a: unknown[]): void => send('error', a),
  /** Console only (DevTools): hot-path diagnostics that must not flood the log file. */
  debug: (...a: unknown[]): void => console.debug(...a),
};

function send(level: 'info' | 'warn' | 'error', a: unknown[]): void {
  const msg = a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : safeJson(x))).join(' ');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(msg); // web: console only
  if (platform.kind === 'electron' && allowLine()) {
    try {
      platform.app.log(level, msg.slice(0, 4000));
    } catch {
      // preload not available (tests)
    }
  }
}

/** The file stays bounded when something loops on an error: at most LINES_PER_MIN lines a minute. */
const LINES_PER_MIN = 120;
let windowStart = 0;
let lines = 0;
let dropped = 0;

function allowLine(): boolean {
  const now = Date.now();
  if (now - windowStart >= 60_000) {
    if (dropped > 0) {
      try {
        platform.app.log('warn', `renderer log: ${dropped} lines dropped (over ${LINES_PER_MIN}/min)`);
      } catch {
        // preload not available (tests)
      }
    }
    windowStart = now;
    lines = 0;
    dropped = 0;
  }
  if (lines >= LINES_PER_MIN) {
    dropped++;
    return false;
  }
  lines++;
  return true;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(x);
  }
}
