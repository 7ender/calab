/**
 * Presenter's annotation overlay (ADR-0028): the renderer hands main already validated
 * annotations of *my* stream; main forwards them to the click-through overlay window over the
 * shared display. Plain data (structured clone over IPC); main re-checks the shape anyway.
 */

/**
 * main → overlay page channel. Lives here, not in IPC (shared/ipc.ts): the two preloads must not
 * import a common module — rollup would split it into a chunk, and a sandboxed preload cannot
 * `require` a file.
 */
export const ANNOT_OVERLAY_CHANNEL = 'annot:overlay-message';

/** One annotation for a scene (renderer/lib/annot/scene.ts `SceneEvent`). */
export interface AnnotOverlayEvent {
  /** Sender's LiveKit identity. */
  from: string;
  /** Sender's display name (the pointer's label). */
  name: string;
  kind: 'pointer' | 'stroke' | 'clear';
  color: number;
  /** x0, y0, x1, y1… normalized to the shared screen (0..1). */
  points: number[];
  strokeId: number;
  strokeEnd: boolean;
  /** Sent by the presenter: a clear erases everyone's strokes. */
  owner: boolean;
}

/** What the overlay page receives. */
export interface AnnotOverlayMessage {
  type: 'event';
  ev: AnnotOverlayEvent;
}

/** The shared source to cover: only whole screens get an overlay (window bounds are unknown). */
export interface AnnotOverlayTarget {
  sourceId: string;
  displayId: string;
}

const MAX_POINTS = 60;

/** Validates an event coming over IPC; throws on anything off-shape. */
export function parseOverlayEvent(v: unknown): AnnotOverlayEvent {
  if (typeof v !== 'object' || v === null) throw new Error('invalid annot event');
  const r = v as Record<string, unknown>;
  const kind = r['kind'];
  const pts = r['points'];
  const text = (x: unknown, max: number): string => {
    if (typeof x !== 'string' || x.length > max) throw new Error('invalid annot event');
    return x;
  };
  const int = (x: unknown, max: number): number => {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > max) throw new Error('invalid annot event');
    return x;
  };
  if (kind !== 'pointer' && kind !== 'stroke' && kind !== 'clear') throw new Error('invalid annot event');
  if (!Array.isArray(pts) || pts.length % 2 !== 0 || pts.length > MAX_POINTS * 2) throw new Error('invalid annot event');
  const points = pts.map((p: unknown) => {
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('invalid annot event');
    return p;
  });
  if (typeof r['strokeEnd'] !== 'boolean' || typeof r['owner'] !== 'boolean') throw new Error('invalid annot event');
  return {
    from: text(r['from'], 256),
    name: text(r['name'], 200),
    kind,
    color: int(r['color'], 0xffffff),
    points,
    strokeId: int(r['strokeId'], 0xffffffff),
    strokeEnd: r['strokeEnd'],
    owner: r['owner'],
  };
}

export function parseOverlayTarget(v: unknown): AnnotOverlayTarget {
  if (typeof v !== 'object' || v === null) throw new Error('invalid overlay target');
  const r = v as Record<string, unknown>;
  const sourceId = r['sourceId'];
  const displayId = r['displayId'];
  if (typeof sourceId !== 'string' || sourceId.length > 256 || typeof displayId !== 'string' || displayId.length > 64) throw new Error('invalid overlay target');
  return { sourceId, displayId };
}

/** A display's bounds (Electron Rectangle). */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The display a screen source shows, or null (a window, a synthetic test source, unplugged). */
export function displayBoundsFor(target: AnnotOverlayTarget, displays: ReadonlyArray<{ id: number; bounds: Bounds }>): Bounds | null {
  if (!target.sourceId.startsWith('screen:')) return null;
  const d = displays.find((o) => String(o.id) === target.displayId);
  return d ? d.bounds : null;
}

/** Content protection keeps the window out of screen capture: macOS and Windows 10 2004+. */
export function overlaySupported(platform: string): boolean {
  return platform === 'darwin' || platform === 'win32';
}
