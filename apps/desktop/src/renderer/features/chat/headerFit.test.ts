import { describe, expect, it } from 'vitest';
import { headerFit } from './headerFit';

// Owner's bug 27.09: window 1200, room column 320, members column 240 → the chat (and its header)
// is 567 px; icon + name + buttons of a short room take ~300 px, of the longest name ~470 px.
describe('headerFit', () => {
  it('keeps normal spacing while everything fits', () => {
    expect(headerFit(567, 300)).toEqual({ tight: false });
    expect(headerFit(567, 470)).toEqual({ tight: false });
    expect(headerFit(567, 567)).toEqual({ tight: false });
  });

  it('tightens the spacing when the buttons and name overflow', () => {
    expect(headerFit(567, 568)).toEqual({ tight: true });
  });
});
