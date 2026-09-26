/**
 * Video tiles of a voice room (docs/09 #42): which participants get a tile, which one is large,
 * and where every tile goes. Pure, unit-tested; VideoStage.tsx only renders the result.
 */

export const MAX_TILES = 6;
const ASPECT = 16 / 9;

export interface TilePerson {
  userId: string;
  /** Publishes a camera the viewer can show (not hidden with «Не показывать видео»). */
  video: boolean;
}

export interface TileSelection {
  /** In display order; the featured tile (if any) first. */
  tiles: TilePerson[];
  /** People who did not fit (shown as «+N» on the last tile). */
  overflow: number;
  /** Large tile: the one the viewer clicked, else the active speaker once there are ≥ 3 tiles. */
  featured: string | null;
}

/**
 * Tile order: the clicked (focused) tile, then cameras, then everyone else; inside each group
 * the most recent speakers first, then the call order. At most MAX_TILES: with more people the
 * last slot turns into «+N».
 */
export function selectTiles(
  people: readonly TilePerson[],
  opts: { focused: string | null; lastSpoke: Readonly<Record<string, number>>; max?: number },
): TileSelection {
  const max = opts.max ?? MAX_TILES;
  const order = new Map(people.map((p, i) => [p.userId, i]));
  const spoke = (id: string): number => opts.lastSpoke[id] ?? -1;
  const focused = opts.focused && order.has(opts.focused) ? opts.focused : null;
  const sorted = [...people].sort((a, b) => {
    if (a.userId === focused) return -1;
    if (b.userId === focused) return 1;
    if (a.video !== b.video) return a.video ? -1 : 1;
    return spoke(b.userId) - spoke(a.userId) || (order.get(a.userId) ?? 0) - (order.get(b.userId) ?? 0);
  });
  const fits = sorted.length <= max;
  const tiles = fits ? sorted : sorted.slice(0, max - 1);
  const overflow = fits ? 0 : sorted.length - tiles.length;
  let featured: string | null = focused;
  if (!featured && tiles.length >= 3) {
    // The active speaker, preferring one with video; else the first camera.
    const bySpeech = [...tiles].filter((t) => spoke(t.userId) >= 0).sort((a, b) => spoke(b.userId) - spoke(a.userId));
    featured = bySpeech.find((t) => t.video)?.userId ?? tiles.find((t) => t.video)?.userId ?? null;
  }
  if (featured) {
    const i = tiles.findIndex((t) => t.userId === featured);
    if (i > 0) tiles.unshift(...tiles.splice(i, 1));
  }
  return { tiles, overflow, featured };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The largest 16:9 box that fits into w × h. */
function fit(w: number, h: number): { w: number; h: number } {
  const byW = { w, h: w / ASPECT };
  return byW.h <= h ? byW : { w: h * ASPECT, h };
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

/** Equal 16:9 tiles, the column count that makes them largest; rows centred (the last one too). */
function grid(n: number, box: Rect, gap: number): Rect[] {
  let best = { cols: 1, w: 0, h: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const t = fit((box.w - gap * (cols - 1)) / cols, (box.h - gap * (rows - 1)) / rows);
    if (t.w > best.w) best = { cols, ...t };
  }
  const rows = Math.ceil(n / best.cols);
  const top = box.y + (box.h - (rows * best.h + (rows - 1) * gap)) / 2;
  const out: Rect[] = [];
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(best.cols, n - r * best.cols);
    const left = box.x + (box.w - (inRow * best.w + (inRow - 1) * gap)) / 2;
    for (let c = 0; c < inRow; c++) out.push({ x: left + c * (best.w + gap), y: top + r * (best.h + gap), w: best.w, h: best.h });
  }
  return out;
}

/** A row (or column) of `n` equal 16:9 tiles inside `box`, centred along its length. */
function strip(n: number, box: Rect, gap: number, vertical: boolean): Rect[] {
  const t = vertical ? fit(box.w, (box.h - gap * (n - 1)) / n) : fit((box.w - gap * (n - 1)) / n, box.h);
  const len = n * (vertical ? t.h : t.w) + (n - 1) * gap;
  const start = vertical ? box.y + (box.h - len) / 2 : box.x + (box.w - len) / 2;
  return Array.from({ length: n }, (_, i) =>
    vertical
      ? { x: box.x + (box.w - t.w) / 2, y: start + i * (t.h + gap), w: t.w, h: t.h }
      : { x: start + i * (t.w + gap), y: box.y + (box.h - t.h) / 2, w: t.w, h: t.h },
  );
}

/**
 * Positions for `n` tiles in a `width × height` area. Without a featured tile: an equal grid.
 * With one (index 0): it takes the main area, the rest line up in a strip — on the right in a
 * landscape area, underneath in a portrait one.
 */
export function layoutTiles(n: number, featured: boolean, width: number, height: number, gap = 8): Rect[] {
  if (n <= 0 || width <= 0 || height <= 0) return [];
  const box: Rect = { x: 0, y: 0, w: width, h: height };
  if (!featured || n === 1) return grid(n, box, gap).map(round);
  const rest = n - 1;
  const landscape = width / height >= 1.3;
  if (landscape) {
    const side = Math.min(320, Math.max(160, Math.round(width * 0.24)));
    const main = fit(width - side - gap, height);
    const mainRect: Rect = { x: (width - side - gap - main.w) / 2, y: (height - main.h) / 2, w: main.w, h: main.h };
    return [mainRect, ...strip(rest, { x: width - side, y: 0, w: side, h: height }, gap, true)].map(round);
  }
  const low = Math.min(180, Math.max(90, Math.round(height * 0.22)));
  const main = fit(width, height - low - gap);
  const mainRect: Rect = { x: (width - main.w) / 2, y: (height - low - gap - main.h) / 2, w: main.w, h: main.h };
  return [mainRect, ...strip(rest, { x: 0, y: height - low, w: width, h: low }, gap, false)].map(round);
}

/**
 * The camera for the PiP while the chat is open: the latest remote speaker with a camera, else
 * the first remote camera, else my own (a self-view is better than nothing).
 */
export function pipCamera(cameras: readonly string[], me: string, lastSpoke: Readonly<Record<string, number>>): string | null {
  const remote = cameras.filter((id) => id !== me);
  if (remote.length) {
    const spoke = (id: string): number => lastSpoke[id] ?? -1;
    return [...remote].sort((a, b) => spoke(b) - spoke(a))[0] ?? null;
  }
  return cameras.includes(me) ? me : null;
}
