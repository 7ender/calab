import { BoardStatusType, TaskPriority } from '@calaba/protocol';
import { AlertTriangle, Minus } from 'lucide-react';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { cx } from '../../components/ui';
import type { MessageKey } from '../../i18n';
import { dateTimeFormat } from '../../lib/format';

/**
 * Board visuals (docs/08 «Доски», as in Linear): the status glyph by type in the status colour,
 * the priority bars, colours of statuses and labels (0xRRGGBB data), due-date text.
 */
export function colorCss(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** The palette offered for statuses and labels (system colours, readable in both themes). */
export const PALETTE: readonly number[] = [0x8e8e93, 0xaeaeb2, 0xff453a, 0xff9f0a, 0xffcc00, 0x30d158, 0x64d2ff, 0x0a84ff, 0x5e5ce6, 0xbf5af2, 0xff375f, 0xac8e68];

export const STATUS_TYPES: readonly BoardStatusType[] = [
  BoardStatusType.BACKLOG,
  BoardStatusType.UNSTARTED,
  BoardStatusType.STARTED,
  BoardStatusType.COMPLETED,
  BoardStatusType.CANCELLED,
];

export const STATUS_TYPE_LABEL: Record<number, MessageKey> = {
  [BoardStatusType.BACKLOG]: 'boards.type.backlog',
  [BoardStatusType.UNSTARTED]: 'boards.type.unstarted',
  [BoardStatusType.STARTED]: 'boards.type.started',
  [BoardStatusType.COMPLETED]: 'boards.type.completed',
  [BoardStatusType.CANCELLED]: 'boards.type.cancelled',
};

/** Tokens of TaskField.STATUS_TYPE values. */
export const STATUS_TYPE_TOKEN: Record<number, string> = {
  [BoardStatusType.BACKLOG]: 'backlog',
  [BoardStatusType.UNSTARTED]: 'unstarted',
  [BoardStatusType.STARTED]: 'started',
  [BoardStatusType.COMPLETED]: 'completed',
  [BoardStatusType.CANCELLED]: 'cancelled',
};

/**
 * The status glyph (14 px): backlog — a dashed ring, todo — a ring, in progress — a ring with a
 * half pie, done — a filled disc with a check, cancelled — a filled disc with a cross.
 */
export const StatusIcon = memo(function StatusIcon({ type, color, size = 14, className }: { type: BoardStatusType; color: number; size?: number; className?: string }): ReactNode {
  const c = colorCss(color);
  const style: CSSProperties = { width: size, height: size };
  const common = { viewBox: '0 0 14 14', 'aria-hidden': true, className: cx('shrink-0', className), style } as const;
  switch (type) {
    case BoardStatusType.BACKLOG:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" strokeDasharray="2.2 1.6" />
        </svg>
      );
    case BoardStatusType.STARTED:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
          <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill={c} />
        </svg>
      );
    case BoardStatusType.COMPLETED:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path d="M4.3 7.2 6.2 9 9.8 5.2" fill="none" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case BoardStatusType.CANCELLED:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="6.25" fill={c} />
          <path d="M5 5 9 9M9 5 5 9" fill="none" stroke="var(--color-bg)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.5" />
        </svg>
      );
  }
});

export const PRIORITIES: readonly TaskPriority[] = [TaskPriority.NONE, TaskPriority.URGENT, TaskPriority.HIGH, TaskPriority.MEDIUM, TaskPriority.LOW];

export const PRIORITY_LABEL: Record<number, MessageKey> = {
  [TaskPriority.NONE]: 'boards.prio.none',
  [TaskPriority.LOW]: 'boards.prio.low',
  [TaskPriority.MEDIUM]: 'boards.prio.medium',
  [TaskPriority.HIGH]: 'boards.prio.high',
  [TaskPriority.URGENT]: 'boards.prio.urgent',
};

/** Priority: «—» none, urgent — an orange warning square, else 1–3 filled bars of three. */
export const PriorityIcon = memo(function PriorityIcon({ priority, className }: { priority: TaskPriority; className?: string }): ReactNode {
  if (priority === TaskPriority.NONE) return <Minus className={cx('size-3.5 shrink-0 text-faint', className)} aria-hidden />;
  if (priority === TaskPriority.URGENT) return <AlertTriangle className={cx('size-3.5 shrink-0 text-[var(--color-red)]', className)} strokeWidth={2} aria-hidden />;
  const on = priority === TaskPriority.HIGH ? 3 : priority === TaskPriority.MEDIUM ? 2 : 1;
  return (
    <svg viewBox="0 0 14 14" className={cx('size-3.5 shrink-0 text-muted', className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < on ? 1 : 0.3} />
      ))}
    </svg>
  );
});

/** «15 янв.» (this year) / «15 янв. 2027 г.». */
export function formatDue(day: string, today: string): string {
  if (!day) return '';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return dateTimeFormat({ day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(date);
}

/** Overdue: a due date before today on a task not done. */
export const isOverdue = (due: string, today: string, done: boolean): boolean => !!due && !done && due < today;

/** A label chip dot. */
export function Dot({ color, size = 8 }: { color: number; size?: number }): ReactNode {
  return <span className="shrink-0 rounded-full" style={{ width: size, height: size, background: colorCss(color) }} aria-hidden />;
}
