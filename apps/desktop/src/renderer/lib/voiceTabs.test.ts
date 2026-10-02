import { describe, expect, it } from 'vitest';
import { parseClaim, yieldsTo, type VoiceClaim } from './voiceTabs';

const c = (at: number, nonce = 'a', session = 's1'): VoiceClaim => ({ session, at, nonce });

describe('voice ownership across tabs (#40)', () => {
  it('a tab that never joined yields to any join of its auth session', () => {
    expect(yieldsTo('s1', null, c(1))).toBe(true);
  });
  it('the newer join wins', () => {
    expect(yieldsTo('s1', c(1), c(2))).toBe(true);
    expect(yieldsTo('s1', c(2), c(1))).toBe(false);
  });
  it('simultaneous joins: exactly one side yields', () => {
    const a = c(5, 'a');
    const b = c(5, 'b');
    expect(yieldsTo('s1', a, b) !== yieldsTo('s1', b, a)).toBe(true);
  });
  it('another auth session (another account in the browser) is ignored', () => {
    expect(yieldsTo('s1', null, c(1, 'a', 's2'))).toBe(false);
    expect(yieldsTo('', null, c(1, 'a', ''))).toBe(false);
  });
  it('parses only well-formed claims', () => {
    expect(parseClaim({ session: 's', at: 1, nonce: 'n' })).toEqual({ session: 's', at: 1, nonce: 'n' });
    expect(parseClaim({ session: 's', at: '1', nonce: 'n' })).toBeNull();
    expect(parseClaim(null)).toBeNull();
    expect(parseClaim('x')).toBeNull();
  });
});
