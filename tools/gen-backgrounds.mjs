#!/usr/bin/env node
// Built-in camera backgrounds, placeholder set (ADR-0035 §4): our own generated pictures —
// gradients, soft shapes and «blurred rooms» drawn from primitives — no third-party images.
// Deterministic (seeded), 1280×720 WebP ≤ 120 KB + 320×180 thumbnails, and manifest.json.
//
//   node tools/gen-backgrounds.mjs   → apps/desktop/src/renderer/assets/backgrounds/
//
// Real photos replace the set with tools/import-backgrounds.mjs <dir> (no code change).
import { mkdirSync } from 'node:fs';
import { OUT_DIR, withEncoder, writeSet } from './backgrounds-lib.mjs';

const MAX_BYTES = 120 * 1024;

/**
 * One scene, drawn in the page. `arg.kind` picks the recipe, `arg.seed` the random layout, the
 * colours come in `arg.pal`. Everything is blurred at the end: a background is out of focus.
 */
function draw(canvas, arg) {
  const g = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  let s = arg.seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const p = arg.pal;
  const lin = (x0, y0, x1, y1, stops) => {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    stops.forEach((c, i) => gr.addColorStop(i / (stops.length - 1), c));
    return gr;
  };
  const glow = (x, y, r, color, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, color);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = a;
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
    g.globalAlpha = 1;
  };
  g.fillStyle = lin(0, 0, W * 0.4, H, p.sky);
  g.fillRect(0, 0, W, H);
  if (arg.kind === 'glow') {
    for (let i = 0; i < 7; i++) glow(rnd() * W, rnd() * H, 180 + rnd() * 320, p.spots[i % p.spots.length], 0.55);
  } else if (arg.kind === 'waves') {
    for (let i = 0; i < 6; i++) {
      const y0 = H * (0.35 + i * 0.12);
      g.fillStyle = p.spots[i % p.spots.length];
      g.globalAlpha = 0.35;
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) g.lineTo(x, y0 + Math.sin(x / (140 + i * 30) + i) * (26 + i * 6));
      g.lineTo(W, H);
      g.fill();
    }
    g.globalAlpha = 1;
  } else if (arg.kind === 'bokeh') {
    for (let i = 0; i < 46; i++) {
      const r = 14 + rnd() * 60;
      g.globalAlpha = 0.18 + rnd() * 0.3;
      g.fillStyle = p.spots[i % p.spots.length];
      g.beginPath();
      g.arc(rnd() * W, rnd() * H, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  } else if (arg.kind === 'room') {
    // A bright window on the left, a wall, a sofa line, a plant: the shapes of a room, out of focus.
    g.fillStyle = p.spots[0];
    g.fillRect(W * 0.06, H * 0.1, W * 0.3, H * 0.62);
    g.fillStyle = p.spots[1];
    g.fillRect(W * 0.2, H * 0.1, W * 0.012, H * 0.62);
    g.fillRect(W * 0.06, H * 0.4, W * 0.3, H * 0.012);
    g.fillStyle = p.spots[2];
    g.fillRect(0, H * 0.78, W, H * 0.22);
    g.fillStyle = p.spots[3];
    g.fillRect(W * 0.5, H * 0.58, W * 0.42, H * 0.22);
    g.fillStyle = p.spots[4];
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.ellipse(W * 0.44 + (rnd() - 0.5) * 90, H * 0.52 + (rnd() - 0.5) * 160, 30 + rnd() * 30, 12 + rnd() * 14, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
    glow(W * 0.2, H * 0.35, 420, p.spots[0], 0.5);
  } else if (arg.kind === 'shelves') {
    // Book shelves along the back wall, a warm lamp.
    for (let row = 0; row < 4; row++) {
      const y = H * (0.12 + row * 0.2);
      g.fillStyle = p.spots[0];
      g.fillRect(W * 0.45, y + H * 0.15, W * 0.55, H * 0.02);
      let x = W * 0.46;
      while (x < W) {
        const w = 14 + rnd() * 26;
        g.fillStyle = p.spots[1 + Math.floor(rnd() * (p.spots.length - 1))];
        const h = H * (0.1 + rnd() * 0.05);
        g.fillRect(x, y + H * 0.15 - h, w, h);
        x += w + 2 + rnd() * 6;
      }
    }
    glow(W * 0.18, H * 0.3, 360, 'rgba(255,214,150,1)', 0.6);
  } else if (arg.kind === 'horizon') {
    glow(W * 0.62, H * 0.58, 520, p.spots[0], 0.8);
    g.fillStyle = lin(0, H * 0.62, 0, H, [p.spots[1], p.spots[2]]);
    g.fillRect(0, H * 0.62, W, H * 0.38);
    for (let i = 0; i < 5; i++) glow(rnd() * W, H * (0.15 + rnd() * 0.3), 140 + rnd() * 200, p.spots[3], 0.35);
  }
  // Out of focus + a light grain so flat areas do not band after encoding.
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const t = tmp.getContext('2d');
  t.filter = `blur(${arg.blur}px)`;
  // Slightly enlarged so the blur never reaches the transparent outside (no light rim).
  const pad = arg.blur * 3;
  t.drawImage(canvas, -pad, -pad, W + 2 * pad, H + 2 * pad);
  g.clearRect(0, 0, W, H);
  g.drawImage(tmp, 0, 0);
  const img = g.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * 3;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

const SET = [
  { id: 'bg-01', kind: 'glow', seed: 11, blur: 40, name: { ru: 'Рассвет', en: 'Dawn', es: 'Amanecer', 'zh-CN': '黎明' }, pal: { sky: ['#f6d5c3', '#e9c2d8', '#c9c6ec'], spots: ['#ffd9b8', '#f4b6c8', '#b9c3f2', '#fbe7c6'] } },
  { id: 'bg-02', kind: 'waves', seed: 23, blur: 18, name: { ru: 'Океан', en: 'Ocean', es: 'Océano', 'zh-CN': '海洋' }, pal: { sky: ['#0f3a53', '#12506b', '#1b6b7f'], spots: ['#1f7c8f', '#2a93a2', '#15566e', '#3aa3a8'] } },
  { id: 'bg-03', kind: 'bokeh', seed: 37, blur: 10, name: { ru: 'Графит', en: 'Graphite', es: 'Grafito', 'zh-CN': '石墨' }, pal: { sky: ['#1b1d22', '#262a31', '#1d2027'], spots: ['#3b4150', '#555d6e', '#2f3440', '#6b7385'] } },
  { id: 'bg-04', kind: 'bokeh', seed: 41, blur: 14, name: { ru: 'Лес', en: 'Forest', es: 'Bosque', 'zh-CN': '森林' }, pal: { sky: ['#15301f', '#244a2c', '#2f5c35'], spots: ['#6e9d58', '#a7c66f', '#3f7a45', '#d9e39a'] } },
  { id: 'bg-05', kind: 'room', seed: 53, blur: 26, name: { ru: 'Гостиная', en: 'Living room', es: 'Sala de estar', 'zh-CN': '客厅' }, pal: { sky: ['#d8d2c8', '#c9c1b4', '#b9b0a2'], spots: ['#f8f5ee', '#b8ad9c', '#8f8575', '#6f7f8c', '#4e6b45'] } },
  { id: 'bg-06', kind: 'shelves', seed: 67, blur: 22, name: { ru: 'Кабинет', en: 'Study', es: 'Despacho', 'zh-CN': '书房' }, pal: { sky: ['#4a3a2e', '#5b4637', '#3e3027'], spots: ['#2e231b', '#8c5a3c', '#a3824f', '#5e6f73', '#7c3f36', '#c2a878'] } },
  { id: 'bg-07', kind: 'horizon', seed: 79, blur: 30, name: { ru: 'Закат', en: 'Sunset', es: 'Atardecer', 'zh-CN': '日落' }, pal: { sky: ['#2c2350', '#7a3d6b', '#e0775a'], spots: ['#ffc07a', '#b2566a', '#3a2a4f', '#f29e7a'] } },
  { id: 'bg-08', kind: 'glow', seed: 97, blur: 44, name: { ru: 'Туман', en: 'Mist', es: 'Niebla', 'zh-CN': '薄雾' }, pal: { sky: ['#eef1f4', '#e2e7ec', '#f4f5f7'], spots: ['#dfe6ee', '#ffffff', '#d5dde7', '#e9ecef'] } },
];

mkdirSync(OUT_DIR, { recursive: true });
const entries = await withEncoder(async (encode) => {
  const out = [];
  for (const b of SET) {
    const { full, thumb } = await encode(draw, b, MAX_BYTES);
    out.push({ id: b.id, file: `${b.id}.webp`, thumb: `${b.id}.thumb.webp`, name: b.name, fullBytes: full, thumbBytes: thumb });
  }
  return out;
});
writeSet(entries);
