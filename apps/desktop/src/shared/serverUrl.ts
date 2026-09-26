/**
 * Server URL policy (review L11): passwords and tokens must not travel in clear text, so a
 * server is `https://` — plain `http://` only for loopback (local dev / tests). Main enforces it
 * (login, register, settings, restore); `allowInsecure` is the CALABA_ALLOW_INSECURE_HTTP=1
 * escape hatch for a LAN test server.
 */
export type ServerUrlProblem = 'invalid' | 'insecure';

/** The error code main returns for an insecure server URL (mapped to a message in the UI). */
export const INSECURE_SERVER_CODE = 'ERROR_CODE_INSECURE_SERVER';

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

export function serverUrlProblem(url: string, allowInsecure = false): ServerUrlProblem | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'invalid';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return 'invalid';
  return allowInsecure || isLoopbackHost(u.hostname) ? null : 'insecure';
}
