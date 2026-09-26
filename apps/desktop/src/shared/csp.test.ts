import { describe, expect, it } from 'vitest';
import { connectSrc } from './csp';

describe('Electron connect-src (review L3)', () => {
  it('production server: its origin + subdomains (rtc.) over https/wss only', () => {
    expect(connectSrc('https://colaba.gptunnel.ai', 'calaba-api')).toBe(
      "'self' calaba-api: blob: data: https://colaba.gptunnel.ai wss://colaba.gptunnel.ai https://*.colaba.gptunnel.ai wss://*.colaba.gptunnel.ai",
    );
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
