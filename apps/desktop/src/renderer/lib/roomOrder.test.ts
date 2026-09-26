import { describe, expect, it } from 'vitest';
import { categoryDropAt, moveRoom, planCategoryMove, planRoomMove, roomDropAt, stepTarget, type Layout, type Slot } from './roomOrder';

const layout: Layout = [
  { categoryId: null, rooms: ['a', 'b', 'c'] },
  { categoryId: 'X', rooms: ['x1', 'x2'] },
  { categoryId: 'Y', rooms: [] },
];
// Server placements: the top level has gaps (positions 0, 4, 9), categories are contiguous.
const rooms = {
  a: { id: 'a', position: 0, categoryId: '' },
  b: { id: 'b', position: 4, categoryId: '' },
  c: { id: 'c', position: 9, categoryId: '' },
  x1: { id: 'x1', position: 0, categoryId: 'X' },
  x2: { id: 'x2', position: 1, categoryId: 'X' },
};

describe('planRoomMove', () => {
  it('reorders within a container, renumbering it contiguously (only changed rooms)', () => {
    expect(planRoomMove(layout, rooms, 'c', { categoryId: null, index: 0 })).toEqual([
      { roomId: 'c', position: 0, categoryId: '' },
      { roomId: 'a', position: 1, categoryId: '' },
      { roomId: 'b', position: 2, categoryId: '' },
    ]);
  });

  it('moves into a category and renumbers both source and destination', () => {
    expect(planRoomMove(layout, rooms, 'a', { categoryId: 'X', index: 1 })).toEqual([
      { roomId: 'b', position: 0, categoryId: '' },
      { roomId: 'c', position: 1, categoryId: '' },
      { roomId: 'a', position: 1, categoryId: 'X' },
      { roomId: 'x2', position: 2, categoryId: 'X' },
    ]);
  });

  it('moves out of a category to the top level and into an empty category', () => {
    expect(planRoomMove(layout, rooms, 'x2', { categoryId: null, index: 3 })).toEqual([
      { roomId: 'b', position: 1, categoryId: '' },
      { roomId: 'c', position: 2, categoryId: '' },
      { roomId: 'x2', position: 3, categoryId: '' },
    ]);
    expect(planRoomMove(layout, rooms, 'x1', { categoryId: 'Y', index: 0 })).toEqual([
      { roomId: 'x2', position: 0, categoryId: 'X' },
      { roomId: 'x1', position: 0, categoryId: 'Y' },
    ]);
  });

  it('is a no-op for a drop on the same place or an unknown room', () => {
    expect(planRoomMove(layout, rooms, 'b', { categoryId: null, index: 1 })).toEqual([]);
    expect(planRoomMove(layout, rooms, 'c', { categoryId: null, index: 99 })).toEqual([]);
    expect(planRoomMove(layout, rooms, 'nope', { categoryId: null, index: 0 })).toEqual([]);
  });

  it('moveRoom clamps the index and ignores unknown containers', () => {
    expect(moveRoom(layout, 'a', { categoryId: 'X', index: 42 })[1]?.rooms).toEqual(['x1', 'x2', 'a']);
    expect(moveRoom(layout, 'a', { categoryId: 'Z', index: 0 })).toBe(layout);
  });
});

describe('stepTarget (keyboard «Переместить вверх/вниз»)', () => {
  it('steps within a container and crosses into the neighbour at its edge', () => {
    expect(stepTarget(layout, 'b', -1)).toEqual({ categoryId: null, index: 0 });
    expect(stepTarget(layout, 'c', 1)).toEqual({ categoryId: 'X', index: 0 });
    expect(stepTarget(layout, 'x1', -1)).toEqual({ categoryId: null, index: 3 });
    expect(stepTarget(layout, 'x2', 1)).toEqual({ categoryId: 'Y', index: 0 });
    expect(stepTarget(layout, 'a', -1)).toBeNull();
  });
});

describe('planCategoryMove', () => {
  it('returns only the categories whose position changes', () => {
    const cats = [
      { id: 'X', position: 0 },
      { id: 'Y', position: 1 },
      { id: 'Z', position: 5 },
    ];
    expect(planCategoryMove(cats, 'Z', 0)).toEqual([
      { categoryId: 'Z', position: 0 },
      { categoryId: 'X', position: 1 },
      { categoryId: 'Y', position: 2 },
    ]);
    expect(planCategoryMove(cats, 'X', 0)).toEqual([]);
  });
});

describe('roomDropAt (pointer → line)', () => {
  // top level a b c (28 px rows), header X, x1 x2, header Y (empty).
  const slots: Slot[] = [
    { kind: 'room', id: 'a', categoryId: null, top: 0, bottom: 34 },
    { kind: 'room', id: 'b', categoryId: null, top: 36, bottom: 70 },
    { kind: 'room', id: 'c', categoryId: null, top: 72, bottom: 106 },
    { kind: 'header', id: 'X', top: 110, bottom: 138 },
    { kind: 'room', id: 'x1', categoryId: 'X', top: 140, bottom: 174 },
    { kind: 'room', id: 'x2', categoryId: 'X', top: 176, bottom: 210 },
    { kind: 'header', id: 'Y', top: 214, bottom: 242 },
  ];

  it('before a room above its middle, after the previous one below it', () => {
    expect(roomDropAt(layout, slots, 10, 'c')).toEqual({ categoryId: null, index: 0, lineY: 0 });
    expect(roomDropAt(layout, slots, 60, 'a')).toEqual({ categoryId: null, index: 1, lineY: 72 });
  });

  it('upper half of a header = end of the container above; lower half = first in the category', () => {
    expect(roomDropAt(layout, slots, 115, 'a')).toEqual({ categoryId: null, index: 2, lineY: 110 });
    expect(roomDropAt(layout, slots, 139, 'a')).toEqual({ categoryId: 'X', index: 0, lineY: 138 });
    expect(roomDropAt(layout, slots, 160, 'a')).toEqual({ categoryId: 'X', index: 1, lineY: 176 });
  });

  it('into an empty category and past the end of the list', () => {
    expect(roomDropAt(layout, slots, 230, 'a')).toEqual({ categoryId: 'Y', index: 0, lineY: 242 });
    expect(roomDropAt(layout, slots, 400, 'x1')).toEqual({ categoryId: 'Y', index: 0, lineY: 242 });
  });

  it('skips the dragged room itself', () => {
    expect(roomDropAt(layout, slots, 50, 'b')).toEqual({ categoryId: null, index: 1, lineY: 72 });
  });
});

describe('categoryDropAt', () => {
  const sections = [
    { id: 'X', top: 110, bottom: 212 },
    { id: 'Y', top: 214, bottom: 242 },
    { id: 'Z', top: 244, bottom: 300 },
  ];
  it('lands before the first section whose middle is below the pointer', () => {
    expect(categoryDropAt(sections, 120, 'Z')).toEqual({ index: 0, lineY: 110 });
    expect(categoryDropAt(sections, 250, 'X')).toEqual({ index: 1, lineY: 244 });
    expect(categoryDropAt(sections, 999, 'X')).toEqual({ index: 2, lineY: 300 });
  });
});
