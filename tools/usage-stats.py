#!/usr/bin/env python3
"""Aggregate Claude Code token usage for this project from the local transcripts and
write docs/13-usage.md (owner request, 2026-09-26: keep the spend statistics in git).

Sources (machine-local, not in git): ~/.claude/projects/<project>/*.jsonl (lead + teammate
panes) and the scratchpad tasks/*.output files (subagents).

Usage: python3 tools/usage-stats.py [--project DIR ...] [--machine NAME] [--no-write]
  --project  a Claude project dir name (e.g. -Users-mac-Desktop-calab) or a path to one; repeatable.
             Env CALABA_USAGE_PROJECTS (os.pathsep-separated) does the same. Default: auto-detect
             from the repo path (the project dir and its worktrees `<dir>-*`).
  --machine  label of this machine's slice (default: hostname). Env CALABA_USAGE_MACHINE.

Several machines: each run replaces only its own slice in docs/13-usage.data.json; the tables in
docs/13-usage.md are the sum of all slices. Within a machine a message counted twice (transcripts
of one session copied between panes/worktrees) is de-duplicated by message id + request id.
The first run seeds the slice "previous" from the tables already in docs/13-usage.md, so older
numbers are not lost.
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import socket
import subprocess

HOME = os.path.expanduser('~')
DOC, DATA = 'docs/13-usage.md', 'docs/13-usage.data.json'
KEYS = [('in', 'input_tokens'), ('cache_r', 'cache_read_input_tokens'),
        ('cache_w', 'cache_creation_input_tokens'), ('out', 'output_tokens')]


def bucket():
    return {k: 0 for k, _ in KEYS} | {'n': 0}


def add(dst, src):
    for k in dst:
        dst[k] += src[k]


def git(*args):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def encode(path):
    return re.sub(r'[^A-Za-z0-9]', '-', path)


def detect_projects():
    common = git('rev-parse', '--path-format=absolute', '--git-common-dir')
    root = os.path.dirname(common) if common else (git('rev-parse', '--show-toplevel') or os.getcwd())
    enc = encode(root)
    base = f'{HOME}/.claude/projects'
    return sorted({os.path.basename(p) for p in glob.glob(f'{base}/{enc}') + glob.glob(f'{base}/{enc}-*')})


def sources(projects):
    out = []
    for p in projects:
        name = os.path.basename(os.path.normpath(os.path.expanduser(p)))
        out += glob.glob(f'{HOME}/.claude/projects/{name}/*.jsonl')
        out += glob.glob(f'/private/tmp/claude-*/{name}/*/tasks/*.output') + glob.glob(f'/tmp/claude-*/{name}/*/tasks/*.output')
    return sorted(set(out))


def scan(paths):
    per_day, per_model, total, seen = {}, {}, bucket(), set()
    tmin = tmax = None
    for path in paths:
        try:
            fh = open(path, encoding='utf-8', errors='ignore')
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                m = d.get('message') or {}
                u = m.get('usage') if isinstance(m, dict) else None
                if not u:
                    continue
                mid = m.get('id')
                if mid:  # streamed/copied duplicates of one response carry the same ids
                    key = (mid, d.get('requestId'))
                    if key in seen:
                        continue
                    seen.add(key)
                ts = d.get('timestamp')
                t = dt.datetime.fromisoformat(ts.replace('Z', '+00:00')) if ts else None
                day = t.date().isoformat() if t else 'unknown'
                for b in (total, per_day.setdefault(day, bucket()), per_model.setdefault(m.get('model', '?'), bucket())):
                    b['n'] += 1
                    for k, src in KEYS:
                        b[k] += u.get(src, 0) or 0
                if t:
                    tmin = t if tmin is None or t < tmin else tmin
                    tmax = t if tmax is None or t > tmax else tmax
    return {'total': total, 'per_day': per_day, 'per_model': per_model,
            'tmin': tmin.isoformat() if tmin else None, 'tmax': tmax.isoformat() if tmax else None}


def fmt(b):
    return f"{b['n']} | {b['in']/1e6:.2f} | {b['cache_r']/1e6:.0f} | {b['cache_w']/1e6:.1f} | {b['out']/1e6:.2f}"


def row_bucket(cells):
    n, i, cr, cw, o = cells
    return {'n': int(n), 'in': float(i) * 1e6, 'cache_r': float(cr) * 1e6, 'cache_w': float(cw) * 1e6, 'out': float(o) * 1e6}


def parse_doc(text):
    """Seed slice from the tables of an existing docs/13-usage.md (values are rounded there)."""
    s = {'total': bucket(), 'per_day': {}, 'per_model': {}, 'tmin': None, 'tmax': None}
    sec = None
    for line in text.splitlines():
        if line.startswith('## '):
            sec = line[3:].strip()
            continue
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        nums = cells[-5:]
        if len(cells) < 5 or not all(re.fullmatch(r'\d+(\.\d+)?', c) for c in nums):
            continue
        if sec == 'Итого':
            s['total'] = row_bucket(nums)
        elif sec == 'По моделям':
            s['per_model'][cells[0]] = row_bucket(nums)
        elif sec and sec.startswith('По дням'):
            s['per_day'][cells[0]] = row_bucket(nums)
    m = re.search(r'период: (\d{4}-\d\d-\d\d \d\d:\d\d) → (\d{4}-\d\d-\d\d \d\d:\d\d)', text)
    if m:
        s['tmin'], s['tmax'] = (dt.datetime.strptime(x, '%Y-%m-%d %H:%M').replace(tzinfo=dt.timezone.utc).isoformat() for x in m.groups())
    return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--project', action='append', default=[])
    ap.add_argument('--machine', default=os.environ.get('CALABA_USAGE_MACHINE') or socket.gethostname())
    ap.add_argument('--no-write', action='store_true', help='print the totals only')
    a = ap.parse_args()
    projects = a.project or [p for p in os.environ.get('CALABA_USAGE_PROJECTS', '').split(os.pathsep) if p] or detect_projects()
    paths = sources(projects)
    print(f'machine {a.machine}: projects {projects or "none"}, {len(paths)} transcript files')
    mine = scan(paths)

    slices = {}
    if os.path.exists(DATA):
        slices = json.load(open(DATA, encoding='utf-8'))['machines']
    elif os.path.exists(DOC):
        slices = {'previous': parse_doc(open(DOC, encoding='utf-8').read())}
    if mine['total']['n'] or a.machine in slices:
        slices[a.machine] = mine
    if a.no_write:
        print(json.dumps(mine['total']))
        return

    per_day, per_model, total, tmin, tmax = {}, {}, bucket(), None, None
    for s in slices.values():
        add(total, s['total'])
        for d, b in s['per_day'].items():
            add(per_day.setdefault(d, bucket()), b)
        for md, b in s['per_model'].items():
            add(per_model.setdefault(md, bucket()), b)
        for key, cur in (('tmin', tmin), ('tmax', tmax)):
            if s[key]:
                v = dt.datetime.fromisoformat(s[key])
                if key == 'tmin':
                    tmin = v if cur is None or v < cur else cur
                else:
                    tmax = v if cur is None or v > cur else cur

    preface = ''
    if os.path.exists(DOC):
        text = open(DOC, encoding='utf-8').read()
        i = text.find('Обновлено:')
        preface = text[:i] if i > 0 else ''
    machines = ', '.join('%s — %d отв.' % (k, v['total']['n']) for k, v in sorted(slices.items()))
    commits = git('rev-list', '--count', 'HEAD')
    span = f' · период: {tmin:%Y-%m-%d %H:%M} → {tmax:%Y-%m-%d %H:%M} UTC ({(tmax - tmin).total_seconds()/3600:.1f} ч)' if tmin and tmax else ''
    lines = [f'Обновлено: {dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} · коммитов: {commits}{span}',
             f'Машины (срезы): {machines}', '',
             'Токены в миллионах. `cache_r` — чтение кэша (основная статья при долгоживущих агентах), `out` — вывод.', '',
             '## Итого', '', '| Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|', f'| {fmt(total)} |', '',
             '## По моделям', '', '| Модель | Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|---|']
    lines += [f'| {m} | {fmt(b)} |' for m, b in sorted(per_model.items(), key=lambda x: -x[1]['out'])]
    lines += ['', '## По дням (UTC)', '', '| День | Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|---|']
    lines += [f'| {d} | {fmt(b)} |' for d, b in sorted(per_day.items())]
    lines += ['', 'Скрипт: `python3 tools/usage-stats.py [--project DIR] [--machine NAME]` (локальные транскрипты Claude Code; '
              'срезы машин — в `docs/13-usage.data.json`, перезаписывается только срез запускающей машины).', '']
    os.makedirs('docs', exist_ok=True)
    json.dump({'machines': slices}, open(DATA, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    open(DOC, 'w', encoding='utf-8').write(preface + '\n'.join(lines))
    print(f"total out {total['out']/1e6:.2f}M, cache_r {total['cache_r']/1e6:.0f}M, days {len(per_day)}")


main()
