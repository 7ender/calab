/**
 * Synthetic "screen" for reproducible bitrate measurements without OS
 * screen-recording permission: a code-editor-like canvas.
 *
 * - static: text never moves; a cursor blinks once per second (like a real
 *   editor) — the "reading code" case.
 * - scroll: text scrolls continuously — the "scrolling through a file" case.
 */
export type TestPatternKind = 'static' | 'scroll';

const KEYWORDS = ['const', 'let', 'return', 'if', 'for', 'await', 'function', 'export', 'import', 'type'];
const IDENTS = ['session', 'room', 'track', 'encoder', 'bitrate', 'layer', 'packet', 'frame', 'jitter', 'gate'];

function codeLine(i: number): string {
  // Deterministic pseudo-code so every run produces identical frames.
  const indent = '  '.repeat(i % 4);
  const kw = KEYWORDS[(i * 7) % KEYWORDS.length] ?? 'const';
  const a = IDENTS[(i * 3) % IDENTS.length] ?? 'x';
  const b = IDENTS[(i * 5 + 1) % IDENTS.length] ?? 'y';
  return `${String(i + 1).padStart(4, ' ')}  ${indent}${kw} ${a}_${i} = ${b}.update(${(i * 37) % 1000}, '${a}-${b}'); // line ${i}`;
}

export interface TestPattern {
  track: MediaStreamTrack;
  stop(): void;
}

export function startTestPattern(kind: TestPatternKind, width: number, height: number, fps: number): TestPattern {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D canvas unavailable');

  const fontPx = Math.max(12, Math.round(height / 60));
  const lineH = Math.round(fontPx * 1.45);
  const lines = Array.from({ length: 2000 }, (_, i) => codeLine(i));
  let offsetPx = 0;
  let frame = 0;

  const draw = (): void => {
    ctx.fillStyle = '#1e1f24';
    ctx.fillRect(0, 0, width, height);
    ctx.font = `${fontPx}px Menlo, Consolas, monospace`;
    ctx.textBaseline = 'top';
    const first = Math.floor(offsetPx / lineH);
    const shift = offsetPx % lineH;
    const visible = Math.ceil(height / lineH) + 1;
    for (let i = 0; i < visible; i++) {
      const idx = (first + i) % lines.length;
      ctx.fillStyle = idx % 5 === 0 ? '#c678dd' : idx % 3 === 0 ? '#98c379' : '#d7dae0';
      ctx.fillText(lines[idx] ?? '', 16, i * lineH - shift + 8);
    }
    // Blinking cursor: the only change in "static" mode (1 Hz).
    if (Math.floor((frame / fps) * 2) % 2 === 0) {
      ctx.fillStyle = '#528bff';
      ctx.fillRect(16 + fontPx * 30, 8 + lineH * 10, 2, lineH);
    }
    frame++;
    if (kind === 'scroll') offsetPx += Math.max(1, Math.round(lineH / 4)); // ≈4 frames per line
  };

  draw();
  const stream = canvas.captureStream(fps);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('canvas.captureStream returned no track');
  const timer = window.setInterval(draw, 1000 / fps);
  return {
    track,
    stop: () => {
      window.clearInterval(timer);
      track.stop();
    },
  };
}
