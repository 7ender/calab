/** Renderer logging → electron-log file in userData/logs (via main). */
export const log = {
  info: (...a: unknown[]): void => send('info', a),
  warn: (...a: unknown[]): void => send('warn', a),
  error: (...a: unknown[]): void => send('error', a),
};

function send(level: 'info' | 'warn' | 'error', a: unknown[]): void {
  const msg = a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : typeof x === 'string' ? x : safeJson(x))).join(' ');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(msg);
  try {
    window.calaba.app.log(level, msg.slice(0, 8000));
  } catch {
    // preload not available (tests)
  }
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(x);
  }
}
