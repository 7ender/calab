import { describe, expect, it } from 'vitest';
import { createLastRowPin } from './lastRowPin';

describe('createLastRowPin (docs/09 #149)', () => {
  it('pins when the last row grows while at the bottom', () => {
    const pin = createLastRowPin();
    pin.reset(40);
    pin.setAtBottom(true);
    expect(pin.measure(64)).toBe(true); // a reaction row added under the bubble
  });

  it('does nothing when not at the bottom', () => {
    const pin = createLastRowPin();
    pin.reset(40);
    pin.setAtBottom(false);
    expect(pin.measure(64)).toBe(false);
  });

  it('does nothing when the row shrinks (a reaction removed)', () => {
    const pin = createLastRowPin();
    pin.reset(64);
    pin.setAtBottom(true);
    expect(pin.measure(40)).toBe(false);
  });

  it("does nothing on the observer's initial report of an unchanged height", () => {
    const pin = createLastRowPin();
    pin.reset(40);
    pin.setAtBottom(true);
    expect(pin.measure(40)).toBe(false);
  });

  it('a new last message re-baselines without pinning, then later growth still pins', () => {
    const pin = createLastRowPin();
    pin.reset(40);
    pin.setAtBottom(true);
    pin.reset(52); // new message became last, taller than the old one — not a "growth"
    expect(pin.measure(52)).toBe(false);
    expect(pin.measure(80)).toBe(true); // that same message then gets a reaction
  });

  it('fires again on a second, later growth', () => {
    const pin = createLastRowPin();
    pin.reset(40);
    pin.setAtBottom(true);
    expect(pin.measure(64)).toBe(true);
    expect(pin.measure(88)).toBe(true);
  });
});
