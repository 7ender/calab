#!/usr/bin/env python3
"""SVG charts for docs/14-energy.md from the CSVs of tools/energy-bench.py. Stdlib only.

Reads docs/energy/<app>-<scenario>.csv (app: calab-before, calab-after, discord), sums every
process of a sample, and writes to docs/energy/:
  cpu-avg.svg        mean CPU % per scenario, one bar per app
  cpu-p95.svg        p95 CPU % per scenario, one bar per app
  cpu-idle-time.svg  total CPU % over time, idle with the window visible (scenario A)
and prints the table used in docs/14. Run: python3 tools/energy-charts.py
"""
import csv
import glob
import os
import statistics

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'docs', 'energy')

# Fixed series order and colours (categorical slots 1–3; light / dark steps, validated for CVD).
APPS = [
    ('calab-after', 'Calab (оптимизации)', '#2a78d6', '#3987e5'),
    ('discord', 'Discord 0.0.413', '#eb6834', '#d95926'),
    ('calab-before', 'Calab 0.5.1', '#1baf7a', '#199e70'),
]
SCENARIOS = [
    ('A-idle-window', 'A · без звонка,', 'окно видно'),
    ('B-idle-hidden', 'B · без звонка,', 'окно скрыто'),
    ('C-voice-quiet', 'C · голос,', 'тишина'),
    ('D-voice-speech', 'D · голос,', 'речь'),
    ('E-watch-video', 'E · смотрит', 'видео'),
    ('E2-watch-video-hidden', 'E2 · видео,', 'окно скрыто'),
    ('F-stream-720p', 'F · стримит', '720p'),
]


def load(app: str, scenario: str) -> list[tuple[float, float]] | None:
    path = os.path.join(DIR, f'{app}-{scenario}.csv')
    if not os.path.exists(path):
        return None
    per_t: dict[float, float] = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            t = float(r['t_s'])
            per_t[t] = per_t.get(t, 0.0) + float(r['cpu_pct'])
    return sorted(per_t.items())


def p95(xs: list[float]) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))]


def style() -> str:
    rules = [':root{--ink:#0b0b0b;--muted:#52514e;--grid:#e4e3df;--bg:#fcfcfb}']
    dark = [':root{--ink:#ffffff;--muted:#c3c2b7;--grid:#383835;--bg:#1a1a19}']
    for i, (_, _, light, dk) in enumerate(APPS):
        rules.append(f'.s{i}{{fill:{light};stroke:{light}}}')
        dark.append(f'.s{i}{{fill:{dk};stroke:{dk}}}')
    return (
        '<style>' + ''.join(rules)
        + 'text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:var(--muted)}'
        + '.t{font-size:14px;font-weight:600;fill:var(--ink)}.v{fill:var(--ink);font-size:11px}'
        + '.g{stroke:var(--grid);stroke-width:1}.l{fill:none;stroke-width:2}'
        + '@media (prefers-color-scheme:dark){' + ''.join(dark) + '}</style>'
        + '<rect width="100%" height="100%" style="fill:var(--bg)"/>'
    )


def nice_max(v: float) -> float:
    for step in (1, 2, 5, 10, 20, 25, 50):
        if v <= step * 4:
            return step * 4
    return v


def legend(x: float, y: float, present: list[int]) -> str:
    out = []
    for i in present:
        _, label, _, _ = APPS[i]
        out.append(f'<rect class="s{i}" x="{x}" y="{y - 9}" width="10" height="10" rx="2"/><text x="{x + 14}" y="{y}">{label}</text>')
        x += 14 + 7.2 * len(label) + 18
    return ''.join(out)


def bars(stat: str, title: str, fname: str) -> None:
    data: dict[tuple[int, str], float] = {}
    for i, (app, _, _, _) in enumerate(APPS):
        for sc, _, _ in SCENARIOS:
            s = load(app, sc)
            if s:
                xs = [v for _, v in s]
                data[(i, sc)] = statistics.mean(xs) if stat == 'mean' else p95(xs)
    W, H, L, R, T, B = 860, 360, 48, 16, 64, 58
    top = nice_max(max(data.values()))
    ph, pw = H - T - B, W - L - R
    gw = pw / len(SCENARIOS)
    bw = min(22.0, (gw - 16) / len(APPS))
    y = lambda v: T + ph - v / top * ph  # noqa: E731
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="{title}">', style()]
    parts.append(f'<text class="t" x="{L}" y="22">{title}</text>')
    parts.append(legend(L, 44, sorted({i for i, _ in data})))
    for k in range(5):
        v = top / 4 * k
        parts.append(f'<line class="g" x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}"/><text x="{L - 6}" y="{y(v) + 4:.1f}" text-anchor="end">{v:g}</text>')
    for j, (sc, l1, l2) in enumerate(SCENARIOS):
        present = [i for i in range(len(APPS)) if (i, sc) in data]
        x0 = L + j * gw + (gw - len(present) * (bw + 2)) / 2
        for n, i in enumerate(present):
            v = data[(i, sc)]
            x = x0 + n * (bw + 2)
            h = max(0.5, T + ph - y(v))
            r = min(4, h / 2, bw / 2)
            # Rounded data end, square at the baseline.
            parts.append(
                f'<path class="s{i}" d="M{x:.1f},{T + ph} v{-(h - r):.1f} q0,{-r:.1f} {r:.1f},{-r:.1f} h{bw - 2 * r:.1f} q{r:.1f},0 {r:.1f},{r:.1f} v{h - r:.1f} z">'
                f'<title>{APPS[i][1]} · {l1} {l2}: {v:.1f} %</title></path>'
            )
            parts.append(f'<text class="v" x="{x + bw / 2:.1f}" y="{T + ph - h - 4:.1f}" text-anchor="middle">{v:.1f}</text>')
        cx = L + j * gw + gw / 2
        parts.append(f'<text x="{cx:.1f}" y="{H - B + 18}" text-anchor="middle">{l1}</text><text x="{cx:.1f}" y="{H - B + 33}" text-anchor="middle">{l2}</text>')
    parts.append(f'<text x="{L}" y="{H - 6}">CPU, % одного ядра (сумма всех процессов приложения, top каждые 5 с) · Discord: только A и B</text>')
    parts.append('</svg>')
    with open(os.path.join(DIR, fname), 'w') as f:
        f.write('\n'.join(parts) + '\n')


def timeline() -> None:
    series = [(i, load(app, 'A-idle-window')) for i, (app, _, _, _) in enumerate(APPS)]
    series = [(i, s) for i, s in series if s]
    W, H, L, R, T, B = 860, 280, 48, 16, 64, 44
    top = nice_max(max(v for _, s in series for _, v in s))
    tmax = max(t for _, s in series for t, _ in s)
    ph, pw = H - T - B, W - L - R
    x = lambda t: L + t / tmax * pw  # noqa: E731
    y = lambda v: T + ph - v / top * ph  # noqa: E731
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-label="CPU без звонка по времени">', style()]
    parts.append(f'<text class="t" x="{L}" y="22">Без звонка, окно видно: CPU по времени (3 мин)</text>')
    parts.append(legend(L, 44, [i for i, _ in series]))
    for k in range(5):
        v = top / 4 * k
        parts.append(f'<line class="g" x1="{L}" x2="{W - R}" y1="{y(v):.1f}" y2="{y(v):.1f}"/><text x="{L - 6}" y="{y(v) + 4:.1f}" text-anchor="end">{v:g}</text>')
    for t in range(0, int(tmax) + 1, 30):
        parts.append(f'<text x="{x(t):.1f}" y="{H - B + 18}" text-anchor="middle">{t} с</text>')
    for i, s in series:
        pts = ' '.join(f'{x(t):.1f},{y(v):.1f}' for t, v in s)
        parts.append(f'<polyline class="l s{i}" style="fill:none" points="{pts}"><title>{APPS[i][1]}</title></polyline>')
    parts.append(f'<text x="{L}" y="{H - 6}">CPU, % одного ядра, сумма процессов; точка = 5 с</text>')
    parts.append('</svg>')
    with open(os.path.join(DIR, 'cpu-idle-time.svg'), 'w') as f:
        f.write('\n'.join(parts) + '\n')


def table() -> None:
    print('| Сценарий | ' + ' | '.join(label for _, label, _, _ in APPS) + ' |')
    print('|---|' + '---|' * len(APPS))
    for sc, l1, l2 in SCENARIOS:
        cells = []
        for app, _, _, _ in APPS:
            s = load(app, sc)
            cells.append(f'{statistics.mean(v for _, v in s):.2f} / {p95([v for _, v in s]):.1f}' if s else '—')
        print(f'| {l1} {l2} | ' + ' | '.join(cells) + ' |')


if __name__ == '__main__':
    bars('mean', 'Средний CPU по сценариям', 'cpu-avg.svg')
    bars('p95', 'CPU p95 по сценариям', 'cpu-p95.svg')
    timeline()
    table()
    print('→', ', '.join(sorted(os.path.basename(p) for p in glob.glob(os.path.join(DIR, '*.svg')))))
