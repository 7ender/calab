import { create } from '@bufbuild/protobuf';
import { BoardCategorySchema, BoardSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { planRoomMove } from '../roomOrder';
import { boardLayout, boardPlacements, layoutTokens } from './categories';

const board = (id: string, position: number, categoryId = '') => create(BoardSchema, { id, position, categoryId, name: id, workspaceId: 'w' });
const cat = (id: string, position: number) => create(BoardCategorySchema, { id, position, name: id, workspaceId: 'w' });

describe('board categories in the list (ADR-0058 §1)', () => {
  const boards = [board('a', 0), board('b', 1, 'c2'), board('c', 0, 'c2'), board('d', 0, 'gone')];
  const cats = [cat('c2', 1), cat('c1', 0)];

  it('top level first, then categories by position; unknown category → top level', () => {
    expect(boardLayout(boards, cats, true)).toEqual([
      { categoryId: null, rooms: ['a', 'd'] },
      { categoryId: 'c1', rooms: [] },
      { categoryId: 'c2', rooms: ['c', 'b'] },
    ]);
  });

  it('hides empty categories from people who do not arrange them', () => {
    expect(boardLayout(boards, cats, false).map((c) => c.categoryId)).toEqual([null, 'c2']);
  });

  it('tokens: headers and rows; a collapsed category keeps only the open board', () => {
    const layout = boardLayout(boards, cats, true);
    expect(layoutTokens(layout, {}, '')).toEqual(['b:a', 'b:d', 'h:c1', 'h:c2', 'b:c', 'b:b']);
    expect(layoutTokens(layout, { c2: true }, 'b')).toEqual(['b:a', 'b:d', 'h:c1', 'h:c2', 'b:b']);
  });

  it('a drag into a category plans the changed placements of the touched containers only', () => {
    const layout = boardLayout(boards, cats, true);
    const placed = Object.fromEntries(boards.map((b) => [b.id, { id: b.id, position: b.position, categoryId: b.categoryId }]));
    const plan = boardPlacements(planRoomMove(layout, placed, 'a', { categoryId: 'c1', index: 0 }));
    // «d» renumbers (its stored category is unknown), «a» lands in c1; c2 is untouched.
    expect(plan).toEqual([
      { boardId: 'd', categoryId: '', position: 0 },
      { boardId: 'a', categoryId: 'c1', position: 0 },
    ]);
  });
});
