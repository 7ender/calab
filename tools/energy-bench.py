#!/usr/bin/env python3
"""CPU / energy sampler for one desktop app (docs/14-energy.md). macOS, stdlib only.

Samples every process of the app — main + all helpers (GPU, renderer, network, audio, plugin …),
found by the app bundle path in their command line — with `top -l` every INTERVAL seconds and
writes one CSV row per process per sample to docs/energy/<name>-<scenario>.csv:

    t_s,pid,kind,cpu_pct,power,mem

`cpu_pct` is % of one core (top's %CPU), `power` is top's POWER column (Apple's energy impact
estimate, the same number Activity Monitor shows). top's first sample has no CPU delta and is
dropped. Prints mean / p95 of the per-sample total (all processes) and per process kind.

    python3 tools/energy-bench.py /Applications/Discord.app discord idle-window --seconds 180
    python3 tools/energy-bench.py "$TMPDIR/calab/Calab.app" calab in-call-quiet
    python3 tools/energy-bench.py "$TMPDIR/calab/Calab.app" calab in-call-quiet --system WindowServer

`--system NAME` also samples system processes by exact name (e.g. WindowServer, the macOS
compositor that pays for window vibrancy / blur): kind `sys:<name>`, excluded from the app total.

Only processes alive when the run starts are sampled: set the scenario up first (join the call,
hide the window), then start the run. Battery vs AC is recorded in the summary (`pmset -g batt`).
"""
import argparse
import csv
import os
import re
import statistics
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def processes(bundle: str) -> dict[int, str]:
    """pid → kind for every process whose executable lives inside `bundle`."""
    out = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True, check=True).stdout
    prefix = bundle.rstrip('/') + '/'
    found: dict[int, str] = {}
    for line in out.splitlines():
        pid_s, _, cmd = line.strip().partition(' ')
        if not cmd.startswith(prefix):
            continue
        found[int(pid_s)] = kind_of(cmd)
    return found


def system_pids(name: str) -> list[int]:
    """pids of the processes whose executable name is exactly `name` (e.g. WindowServer)."""
    out = subprocess.run(['pgrep', '-x', name], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]


def kind_of(cmd: str) -> str:
    m = re.search(r'--utility-sub-type=([\w.]+)', cmd)
    if m:
        return 'utility:' + m.group(1).split('.')[0]
    m = re.search(r'--type=([\w-]+)', cmd)
    if m:
        return m.group(1)
    if '(Plugin)' in cmd:
        return 'plugin'
    return 'main' if '/Contents/MacOS/' in cmd and 'Helper' not in cmd else 'helper'


def power_source() -> str:
    out = subprocess.run(['pmset', '-g', 'batt'], capture_output=True, text=True).stdout
    src = 'battery' if 'Battery Power' in out else 'ac'
    pct = re.search(r'(\d+)%', out)
    return f'{src} {pct.group(1)}%' if pct else src


def sample(pids: list[int], seconds: int, interval: int) -> list[tuple[float, int, float, float, str]]:
    n = seconds // interval + 1
    args = ['top', '-l', str(n), '-s', str(interval), '-stats', 'pid,command,cpu,power,mem']
    for p in pids:
        args += ['-pid', str(p)]
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    rows: list[tuple[float, int, float, float, str]] = []
    k = -1
    for line in out.splitlines():
        if line.startswith('Processes:'):
            k += 1
            continue
        m = re.match(r'^(\d+)\s+.+?\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s*$', line)
        if m and k >= 1:  # sample 0: no CPU delta yet
            rows.append(((k - 1) * interval, int(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)))
    return rows


def p95(xs: list[float]) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, round(0.95 * (len(xs) - 1)))] if xs else 0.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('bundle', help='app bundle path, e.g. /Applications/Discord.app')
    ap.add_argument('name', help='app name for the CSV file, e.g. discord')
    ap.add_argument('scenario', help='scenario name for the CSV file, e.g. idle-window')
    ap.add_argument('--seconds', type=int, default=180)
    ap.add_argument('--interval', type=int, default=5)
    ap.add_argument('--out', default=os.path.join(ROOT, 'docs', 'energy'))
    ap.add_argument('--system', action='append', default=[], help='also sample this system process by name (repeatable)')
    a = ap.parse_args()

    procs = processes(a.bundle)
    if not procs:
        print(f'no running process inside {a.bundle}', file=sys.stderr)
        return 1
    for name in a.system:
        for pid in system_pids(name):
            procs[pid] = 'sys:' + name
    before = power_source()
    rows = sample(sorted(procs), a.seconds, a.interval)
    after = power_source()

    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, f'{a.name}-{a.scenario}.csv')
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['t_s', 'pid', 'kind', 'cpu_pct', 'power', 'mem'])
        for t, pid, cpu, pw, mem in rows:
            w.writerow([t, pid, procs.get(pid, 'other'), cpu, pw, mem])

    totals: dict[float, list[float]] = {}
    kinds: dict[str, dict[float, float]] = {}
    for t, pid, cpu, pw, _ in rows:
        kind = procs.get(pid, 'other')
        tot = totals.setdefault(t, [0.0, 0.0])
        if not kind.startswith('sys:'):  # the app total: the app's own processes only
            tot[0] += cpu
            tot[1] += pw
        k = kinds.setdefault(procs.get(pid, 'other'), {})
        k[t] = k.get(t, 0.0) + cpu
    cpu = [v[0] for v in totals.values()]
    pw = [v[1] for v in totals.values()]
    print(f'{a.name}/{a.scenario}: {len(cpu)} samples × {a.interval} s, power {before} → {after}')
    print(f'  total CPU %  mean {statistics.mean(cpu):6.2f}  p95 {p95(cpu):6.2f}   POWER mean {statistics.mean(pw):6.2f}  p95 {p95(pw):6.2f}')
    for k, series in sorted(kinds.items()):
        xs = list(series.values())
        print(f'  {k:<24} mean {statistics.mean(xs):6.2f}  p95 {p95(xs):6.2f}')
    print(f'  → {os.path.relpath(path, ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
