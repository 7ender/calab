import type { MatchCtx } from '../../lib/boards/filter';
import { useBoards } from '../../stores/boards';
import { prefsOf, useBoardsUi } from '../../stores/boardsUi';
import { memberName } from '../../stores/workspaces';
import { t } from '../../i18n';
import { visibleTasks } from './model';
import { PRIORITY_LABEL } from './visuals';

/** RFC 4180 field. */
export function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Excel opens UTF-8 CSV correctly only with a byte order mark. */
const BOM = String.fromCharCode(0xfeff);

/**
 * «Экспорт CSV» (ADR-0042 §5): the tasks the board shows now (filter applied), one row each —
 * key, title, status, priority, assignees (lead first, with notes), labels, dates, estimate.
 */
export function exportCsv(boardId: string, ctx: MatchCtx): void {
  const s = useBoards.getState();
  const b = s.boards[boardId];
  if (!b) return;
  const prefs = prefsOf(useBoardsUi.getState(), boardId);
  const rows = visibleTasks(s, b, prefs, ctx);
  const status = new Map(b.statuses.map((x) => [x.id, x.name]));
  const label = new Map(b.labels.map((x) => [x.id, x.name]));
  const head = ['key', 'title', 'status', 'priority', 'assignees', 'labels', 'start_on', 'due_on', 'estimate'];
  const lines = [head.join(',')];
  for (const task of rows) {
    const who = task.assignees.map((a) => `${memberName(b.workspaceId, a.userId)}${a.isLead ? ' *' : ''}${a.note ? ` (${a.note})` : ''}`).join('; ');
    lines.push(
      [task.key, task.title, status.get(task.statusId) ?? '', t(PRIORITY_LABEL[task.priority] ?? 'boards.prio.none'), who, task.labelIds.map((l) => label.get(l) ?? '').join('; '), task.startOn, task.dueOn, task.estimate ? String(task.estimate) : '']
        .map(csvField)
        .join(','),
    );
  }
  const blob = new Blob([`${BOM}${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${b.key}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
