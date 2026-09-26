import { describe, expect, it } from 'vitest';
import { layoutTiles, pipCamera, selectTiles, type Rect, type TilePerson } from './tileLayout';

const P = (userId: string, video = false): TilePerson => ({ userId, video });

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number): boolean => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

describe('selectTiles', () => {
  it('stable order: cameras first, then call order — speech does not reorder', () => {
    const s = selectTiles([P('a'), P('b', true), P('c'), P('d', true)], { focused: null, active: 'c' });
    expect(s.tiles.map((t) => t.userId)).toEqual(['b', 'd', 'a', 'c']);
    expect(s.overflow).toBe(0);
  });

  it('my own camera is never large by default, only when I click it', () => {
    const people = [P('me', true), P('b', true), P('c')];
    expect(selectTiles(people, { focused: null, active: 'me', me: 'me' }).featured).toBe('b');
    expect(selectTiles([P('me', true), P('b'), P('c')], { focused: null, active: null, me: 'me' }).featured).toBeNull();
    expect(selectTiles(people, { focused: 'me', active: null, me: 'me' }).featured).toBe('me');
  });

  it('features the active speaker if they show video, else the first remote camera (≥ 3 tiles)', () => {
    const people = [P('a', true), P('b', true), P('c')];
    expect(selectTiles(people, { focused: null, active: 'b' }).featured).toBe('b');
    expect(selectTiles(people, { focused: null, active: 'b' }).tiles[0]?.userId).toBe('b');
    // c talks but has no camera: the first camera stays large.
    expect(selectTiles(people, { focused: null, active: 'c' }).featured).toBe('a');
  });

  it('no featured tile for 1–2 tiles unless one is clicked', () => {
    expect(selectTiles([P('a', true), P('b')], { focused: null, active: 'b' }).featured).toBeNull();
    const s = selectTiles([P('a', true), P('b')], { focused: 'b', active: null });
    expect(s.featured).toBe('b');
    expect(s.tiles.map((t) => t.userId)).toEqual(['b', 'a']);
  });

  it('a focus on someone who left is ignored', () => {
    expect(selectTiles([P('a', true)], { focused: 'gone', active: null }).featured).toBeNull();
  });

  it('caps at 6 tiles: 5 people + «+N»', () => {
    const people = Array.from({ length: 9 }, (_, i) => P(`u${i}`, i < 2));
    const s = selectTiles(people, { focused: null, active: null });
    expect(s.tiles).toHaveLength(5);
    expect(s.overflow).toBe(4);
    expect(s.tiles.slice(0, 2).every((t) => t.video)).toBe(true);
    expect(selectTiles(people.slice(0, 6), { focused: null, active: null })).toMatchObject({ overflow: 0 });
  });
});

describe('layoutTiles', () => {
  it('one tile fills the area at 16:9', () => {
    expect(layoutTiles(1, false, 1600, 900)).toEqual([{ x: 0, y: 0, w: 1600, h: 900 }]);
    const [r] = layoutTiles(1, true, 1000, 900);
    expect(r).toMatchObject({ w: 1000, h: 563 });
  });

  it('equal grid: 2 side by side in a wide area, 4 as 2×2 in a square one', () => {
    const two = layoutTiles(2, false, 1200, 400, 8);
    expect(two[0]?.y).toBe(two[1]?.y);
    expect(two[0]?.w).toBe(two[1]?.w);
    const four = layoutTiles(4, false, 1000, 1000, 8);
    expect(new Set(four.map((r) => r.y)).size).toBe(2);
    expect(new Set(four.map((r) => r.x)).size).toBe(2);
  });

  it('featured tile is the largest; the strip sits right in a very wide area, below otherwise', () => {
    for (const [w, h, right] of [
      [1600, 500, true],
      [845, 620, false],
      [700, 900, false],
    ] as const) {
      const rects = layoutTiles(3, true, w, h, 8);
      const [main, ...rest] = rects;
      if (!main) throw new Error('no tiles');
      for (const r of rest) expect(r.w * r.h).toBeLessThan(main.w * main.h);
      if (right) for (const r of rest) expect(r.x).toBeGreaterThanOrEqual(main.x + main.w);
      else for (const r of rest) expect(r.y).toBeGreaterThanOrEqual(main.y + main.h);
    }
  });

  it('the featured layout uses the height: main tile ≥ 70 % of a 845×620 area height', () => {
    const [main] = layoutTiles(3, true, 845, 620, 8);
    expect(main?.h ?? 0).toBeGreaterThanOrEqual(0.7 * 620);
  });

  it('tiles never overlap and stay inside the area, for every count and shape', () => {
    for (let n = 1; n <= 6; n++) {
      for (const featured of [false, true]) {
        for (const [w, h] of [
          [960, 420],
          [1440, 640],
          [600, 800],
          [320, 180],
        ] as const) {
          const rects = layoutTiles(n, featured, w, h, 8);
          expect(rects).toHaveLength(n);
          rects.forEach((a, i) => {
            expect(inside(a, w, h), `n=${n} f=${featured} ${w}×${h} #${i}`).toBe(true);
            expect(Math.abs(a.w / a.h - 16 / 9)).toBeLessThan(0.02);
            rects.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false));
          });
        }
      }
    }
  });

  it('empty area → no tiles', () => {
    expect(layoutTiles(3, false, 0, 500)).toEqual([]);
    expect(layoutTiles(0, false, 500, 500)).toEqual([]);
  });
});

describe('pipCamera', () => {
  it('the active remote speaker, else the first remote camera, else me', () => {
    expect(pipCamera(['me', 'a', 'b'], 'me', 'b')).toBe('b');
    expect(pipCamera(['me', 'a', 'b'], 'me', 'me')).toBe('a');
    expect(pipCamera(['me', 'a'], 'me', 'gone')).toBe('a');
    expect(pipCamera(['me'], 'me', null)).toBe('me');
    expect(pipCamera([], 'me', null)).toBeNull();
  });
});
