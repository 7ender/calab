#!/usr/bin/env python3
"""Aggregate Claude Code token usage for this project from the local transcripts and
write docs/13-usage.md (owner request, 2026-09-26: keep the spend statistics in git).

Sources (machine-local, not in git): ~/.claude/projects/<project>/*.jsonl (lead + teammate
panes) and the scratchpad tasks/*.output files (subagents). Run: python3 tools/usage-stats.py
"""
import datetime as dt
import glob
import json
import os
import subprocess

HOME = os.path.expanduser('~')
PROJECT = '-Users-macbook-Documents-Projects-Calaba'
SOURCES = glob.glob(f'{HOME}/.claude/projects/{PROJECT}/*.jsonl') + glob.glob(
    f'/private/tmp/claude-501/{PROJECT}/*/tasks/*.output'
)
KEYS = [('in', 'input_tokens'), ('cache_r', 'cache_read_input_tokens'),
        ('cache_w', 'cache_creation_input_tokens'), ('out', 'output_tokens')]


def bucket():
    return {k: 0 for k, _ in KEYS} | {'n': 0}


per_day, per_model, total = {}, {}, bucket()
tmin = tmax = None
for path in SOURCES:
    try:
        fh = open(path, encoding='utf-8', errors='ignore')
    except OSError:
        continue
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


def fmt(b):
    return f"{b['n']} | {b['in']/1e6:.2f} | {b['cache_r']/1e6:.0f} | {b['cache_w']/1e6:.1f} | {b['out']/1e6:.2f}"


commits = subprocess.run(['git', 'rev-list', '--count', 'HEAD'], capture_output=True, text=True).stdout.strip()
lines = ['# Затраты на разработку (токены и время)', '',
         f'Обновлено: {dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")} · коммитов: {commits} · '
         f'период: {tmin:%Y-%m-%d %H:%M} → {tmax:%Y-%m-%d %H:%M} UTC ({(tmax - tmin).total_seconds()/3600:.1f} ч)' if tmin else '',
         '', 'Токены в миллионах. `cache_r` — чтение кэша (основная статья при долгоживущих агентах), `out` — вывод.', '',
         '## Итого', '', '| Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|', f'| {fmt(total)} |', '',
         '## По моделям', '', '| Модель | Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|---|']
lines += [f'| {m} | {fmt(b)} |' for m, b in sorted(per_model.items(), key=lambda x: -x[1]['out'])]
lines += ['', '## По дням (UTC)', '', '| День | Ответов | in | cache_r | cache_w | out |', '|---|---|---|---|---|---|']
lines += [f'| {d} | {fmt(b)} |' for d, b in sorted(per_day.items())]
lines += ['', 'Скрипт: `python3 tools/usage-stats.py` (читает локальные транскрипты Claude Code на машине владельца).', '']
os.makedirs('docs', exist_ok=True)
open('docs/13-usage.md', 'w', encoding='utf-8').write('\n'.join(lines))
print(f"total out {total['out']/1e6:.2f}M, cache_r {total['cache_r']/1e6:.0f}M, days {len(per_day)}")
