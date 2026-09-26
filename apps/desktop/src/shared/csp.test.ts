import { describe, expect, it } from 'vitest';
import { connectSrc } from './csp';

/** Minimal CSP host-source matcher (scheme + host with a leading `*.` wildcard + port). */
function allows(policy: string, url: string): boolean {
  const u = new URL(url);
  return policy.split(' ').some((src) => {
    const m = /^(https?|wss?):\/\/([^/:]+)(?::(\d+|\*))?$/.exec(src);
    if (!m || `${m[1]}:` !== u.protocol) return false;
    const [, , host = '', port] = m;
    const hostOk = host.startsWith('*.') ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
    return hostOk && (port === '*' || (port ?? '') === u.port);
  });
}

describe('Electron connect-src (review L3)', () => {
  it('production server: its origin, subdomains and sibling subdomains over https/wss only', () => {
    expect(connectSrc('https://colaba.gptunnel.ai', 'calaba-api')).toBe(
      "'self' calaba-api: blob: data: https://colaba.gptunnel.ai wss://colaba.gptunnel.ai https://*.colaba.gptunnel.ai wss://*.colaba.gptunnel.ai https://*.gptunnel.ai wss://*.gptunnel.ai",
    );
  });
  it('app.calab.ru: LiveKit/TURN on sibling hosts are allowed (P0 bug 1), foreign hosts are not', () => {
    const s = connectSrc('https://app.calab.ru', 'calaba-api');
    expect(allows(s, 'wss://rtc.calab.ru')).toBe(true);
    expect(allows(s, 'https://rtc.calab.ru/rtc/validate')).toBe(true);
    expect(allows(s, 'wss://turn.calab.ru')).toBe(true);
    expect(allows(s, 'wss://app.calab.ru/ws')).toBe(true);
    expect(allows(s, 'wss://evil.com')).toBe(false);
    expect(allows(s, 'wss://calab.ru.evil.com')).toBe(false);
    expect(allows(s, 'ws://rtc.calab.ru')).toBe(false);
  });
  it('meet.gptunnel.ru: its siblings only; rtc.calab.ru needs an explicit extra source', () => {
    const s = connectSrc('https://meet.gptunnel.ru', 'calaba-api');
    expect(allows(s, 'wss://rtc.gptunnel.ru')).toBe(true);
    expect(allows(s, 'wss://rtc.calab.ru')).toBe(false);
    const withExtra = connectSrc('https://meet.gptunnel.ru', 'calaba-api', 'wss://rtc.calab.ru https://rtc.calab.ru');
    expect(allows(withExtra, 'wss://rtc.calab.ru')).toBe(true);
    expect(allows(withExtra, 'wss://turn.calab.ru')).toBe(false);
  });
  it('2-label host never widens to its public suffix; IP hosts are not widened', () => {
    const s = connectSrc('https://calab.ru', 'calaba-api');
    expect(s).toContain('wss://*.calab.ru');
    expect(s).not.toContain('*.ru ');
    expect(s.endsWith('*.ru')).toBe(false);
    const ip = connectSrc('http://141.105.69.177', 'calaba-api');
    expect(ip).not.toContain('*.105.69.177');
  });
  it('keeps a non-default port', () => {
    expect(connectSrc('https://example.org:8443', 'calaba-api')).toContain('wss://example.org:8443');
  });
  it('loopback dev/test server: any loopback port (local LiveKit)', () => {
    const s = connectSrc('http://127.0.0.1:3900', 'calaba-api');
    expect(s).toContain('ws://127.0.0.1:*');
    expect(s).toContain('http://localhost:*');
    expect(s).not.toContain('https:');
  });
  it('extra sources are validated; no server → local sources only', () => {
    expect(connectSrc('', 'calaba-api', "wss://lk.other.net 'unsafe-inline' javascript:x https://ok.example")).toBe(
      "'self' calaba-api: blob: data: wss://lk.other.net https://ok.example",
    );
  });
});
