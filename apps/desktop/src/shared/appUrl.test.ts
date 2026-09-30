import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_APP_URL_LENGTH, hostOf, validateAppUrl, withScheme } from './appUrl';

interface Vectors {
  cases: { url: string; ok: boolean }[];
}

const vectors = JSON.parse(readFileSync(new URL('../../../../proto/testdata/app_urls.json', import.meta.url), 'utf8')) as Vectors;

describe('validateAppUrl (shared vectors with the server, ADR-0050 §1)', () => {
  it('has the vectors', () => {
    expect(vectors.cases.length).toBeGreaterThan(40);
  });
  for (const c of vectors.cases) {
    it(`${JSON.stringify(c.url)} → ${c.ok ? 'ok' : 'rejected'}`, () => {
      const r = validateAppUrl(c.url);
      expect(r.ok).toBe(c.ok);
      if (r.ok) expect(r.url).toBe(c.url.trim());
    });
  }

  it('bounds the length like the server', () => {
    const base = 'https://example.com/';
    expect(validateAppUrl(base + 'a'.repeat(MAX_APP_URL_LENGTH - base.length)).ok).toBe(true);
    expect(validateAppUrl(base + 'a'.repeat(MAX_APP_URL_LENGTH - base.length + 1)).ok).toBe(false);
  });

  it('accepts full-form IPv6 loopback over http and rejects malformed IPv6', () => {
    expect(validateAppUrl('http://[0:0:0:0:0:0:0:1]/').ok).toBe(true);
    expect(validateAppUrl('https://[1:::2]/').ok).toBe(false);
    expect(validateAppUrl('https://[::ffff:10.0.0.1]/').ok).toBe(false);
  });
});

describe('withScheme', () => {
  it('puts https:// in front of a bare address', () => {
    expect(withScheme(' grafana.example.com/d ')).toBe('https://grafana.example.com/d');
    expect(withScheme('http://intranet')).toBe('http://intranet');
    expect(withScheme('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(withScheme('')).toBe('');
    expect(withScheme('example.com:8443/x')).toBe('https://example.com:8443/x');
  });
});

describe('hostOf', () => {
  it('extracts the host for the navigation strip', () => {
    expect(hostOf('https://Grafana.Example.com:8443/d?x#y')).toBe('grafana.example.com');
    expect(hostOf('https://user@site.test/')).toBe('site.test');
    expect(hostOf('http://[::1]:8080/')).toBe('[::1]');
    expect(hostOf('about:blank')).toBe('');
  });
});
