import { describe, expect, it } from 'vitest';
import { HEADER_SEARCH_SLOT, headerFit } from './headerFit';

// Owner's bug 27.09: window 1200, room column 320, members column 240 → the chat (and its header)
// is 567 px; icon + name + buttons of a short room take ~300 px, of the longest name ~470 px.
describe('headerFit', () => {
  it('shows the search field only when it fits next to everything else', () => {
    expect(headerFit(567, 300)).toEqual({ search: true, tight: false });
    expect(headerFit(567, 567 - HEADER_SEARCH_SLOT)).toEqual({ search: true, tight: false });
    expect(headerFit(567, 567 - HEADER_SEARCH_SLOT + 1)).toEqual({ search: false, tight: false });
    expect(headerFit(567, 470)).toEqual({ search: false, tight: false });
  });

  it('tightens the spacing when even the buttons and name overflow', () => {
    expect(headerFit(567, 568)).toEqual({ search: false, tight: true });
  });
});
