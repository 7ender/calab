import { describe, expect, it } from 'vitest';
import { bweText, rateText } from './StatsOverlay';

describe('stats overlay rates', () => {
  it('kbps, Mbps from 10 000, a dash when unknown', () => {
    expect(rateText(31.6)).toBe('32 kbps');
    expect(rateText(2400)).toBe('2400 kbps');
    expect(rateText(12_345)).toBe('12.3 Mbps');
    expect(rateText(null)).toBe('—');
    expect(rateText(Number.NaN)).toBe('—');
  });

  it('the send estimate at the 1 Gbit/s ceiling is no estimate', () => {
    expect(bweText(1_000_000)).toBe('—');
    expect(bweText(100_000)).toBe('—');
    expect(bweText(1800)).toBe('1800 kbps');
    expect(bweText(undefined)).toBe('—');
  });
});
