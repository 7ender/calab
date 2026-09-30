import { TaskField, TaskOp } from '@calaba/protocol';
import {
  AlignLeft,
  Archive,
  Bell,
  CalendarClock,
  CalendarPlus,
  CalendarRange,
  CircleDashed,
  CircleDot,
  Crown,
  Diamond,
  GitFork,
  History,
  Link2,
  MessageSquare,
  Paperclip,
  SignalHigh,
  Tag,
  Triangle,
  UserPen,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MessageKey } from '../../i18n';

/**
 * The universal filter's field registry (ADR-0042 §3, «Фильтр» as in Linear): one row per
 * `TaskField` — its icon, the kind of values it takes (which picker the UI shows) and the
 * operations offered. The filter UI, the chips, client-side matching (lib/boards/filter.ts) and
 * the TaskFilter conversion all read this table: a new field is one row here (+ the server's
 * translator).
 */
export type ValueKind =
  | 'status'
  | 'statusType'
  | 'user'
  | 'priority'
  | 'number'
  | 'label'
  | 'milestone'
  | 'task'
  | 'relation'
  /** A date without time ("YYYY-MM-DD" or a relative token). */
  | 'date'
  /** An instant (created / updated): sent as from / to. */
  | 'datetime'
  | 'bool'
  | 'text';

export interface FieldDef {
  field: TaskField;
  /** Short name in the field list and chips. */
  label: MessageKey;
  icon: LucideIcon;
  kind: ValueKind;
  ops: readonly TaskOp[];
  /** The op a new condition starts with. */
  op: TaskOp;
  /** Several values at once (checkboxes). */
  multi: boolean;
  /** Shown only in «Мои задачи» / advanced lists (not in a board's field list). */
  hidden?: boolean;
}

const { IS, IS_NOT, ANY_OF, NONE_OF, EMPTY, NOT_EMPTY, BEFORE, AFTER, BETWEEN, GT, LT, CONTAINS } = TaskOp;

export const FILTER_FIELDS: readonly FieldDef[] = [
  { field: TaskField.STATUS, label: 'boards.f.status', icon: CircleDashed, kind: 'status', ops: [IS, IS_NOT], op: IS, multi: true },
  { field: TaskField.STATUS_TYPE, label: 'boards.f.statusType', icon: CircleDot, kind: 'statusType', ops: [IS, IS_NOT], op: IS, multi: true },
  { field: TaskField.ASSIGNEE, label: 'boards.f.assignee', icon: Users, kind: 'user', ops: [IS, IS_NOT, EMPTY, NOT_EMPTY], op: IS, multi: true },
  { field: TaskField.LEAD, label: 'boards.f.lead', icon: Crown, kind: 'user', ops: [IS, IS_NOT, EMPTY, NOT_EMPTY], op: IS, multi: true },
  { field: TaskField.CREATOR, label: 'boards.f.creator', icon: UserPen, kind: 'user', ops: [IS, IS_NOT], op: IS, multi: true },
  { field: TaskField.PRIORITY, label: 'boards.f.priority', icon: SignalHigh, kind: 'priority', ops: [IS, IS_NOT], op: IS, multi: true },
  { field: TaskField.ESTIMATE, label: 'boards.f.estimate', icon: Triangle, kind: 'number', ops: [GT, LT, EMPTY, NOT_EMPTY], op: GT, multi: false },
  { field: TaskField.LABEL, label: 'boards.f.label', icon: Tag, kind: 'label', ops: [ANY_OF, IS, NONE_OF, EMPTY, NOT_EMPTY], op: ANY_OF, multi: true },
  { field: TaskField.MILESTONE, label: 'boards.f.milestone', icon: Diamond, kind: 'milestone', ops: [IS, IS_NOT, EMPTY, NOT_EMPTY], op: IS, multi: true },
  { field: TaskField.PARENT, label: 'boards.f.parent', icon: GitFork, kind: 'task', ops: [IS, EMPTY, NOT_EMPTY], op: NOT_EMPTY, multi: true },
  { field: TaskField.RELATION, label: 'boards.f.relation', icon: Link2, kind: 'relation', ops: [IS, IS_NOT], op: IS, multi: true },
  { field: TaskField.SUBSCRIBER, label: 'boards.f.subscriber', icon: Bell, kind: 'user', ops: [IS], op: IS, multi: true },
  { field: TaskField.CREATED_AT, label: 'boards.f.createdAt', icon: CalendarPlus, kind: 'datetime', ops: [AFTER, BEFORE, BETWEEN], op: AFTER, multi: false },
  { field: TaskField.UPDATED_AT, label: 'boards.f.updatedAt', icon: History, kind: 'datetime', ops: [AFTER, BEFORE, BETWEEN], op: AFTER, multi: false },
  { field: TaskField.START_ON, label: 'boards.f.startOn', icon: CalendarRange, kind: 'date', ops: [BEFORE, AFTER, BETWEEN, EMPTY, NOT_EMPTY], op: BEFORE, multi: false },
  { field: TaskField.DUE_ON, label: 'boards.f.dueOn', icon: CalendarClock, kind: 'date', ops: [BEFORE, AFTER, BETWEEN, EMPTY, NOT_EMPTY], op: BEFORE, multi: false },
  { field: TaskField.HAS_ATTACHMENTS, label: 'boards.f.hasAttachments', icon: Paperclip, kind: 'bool', ops: [IS], op: IS, multi: false },
  { field: TaskField.HAS_COMMENTS, label: 'boards.f.hasComments', icon: MessageSquare, kind: 'bool', ops: [IS], op: IS, multi: false },
  { field: TaskField.TEXT, label: 'boards.f.text', icon: AlignLeft, kind: 'text', ops: [CONTAINS], op: CONTAINS, multi: false },
  { field: TaskField.ARCHIVED, label: 'boards.f.archived', icon: Archive, kind: 'bool', ops: [IS], op: IS, multi: false, hidden: true },
];

const BY_FIELD = new Map(FILTER_FIELDS.map((f) => [f.field, f]));

export function fieldDef(field: TaskField): FieldDef | undefined {
  return BY_FIELD.get(field);
}

/** Label of an operation in a chip; `n` values (IS with several = «любой из»). */
export function opLabel(op: TaskOp, n: number): MessageKey {
  switch (op) {
    case IS:
      return n > 1 ? 'boards.op.anyOf' : 'boards.op.is';
    case IS_NOT:
      return n > 1 ? 'boards.op.noneOf' : 'boards.op.isNot';
    case ANY_OF:
      return 'boards.op.anyOf';
    case NONE_OF:
      return 'boards.op.noneOf';
    case EMPTY:
      return 'boards.op.empty';
    case NOT_EMPTY:
      return 'boards.op.notEmpty';
    case BEFORE:
      return 'boards.op.before';
    case AFTER:
      return 'boards.op.after';
    case BETWEEN:
      return 'boards.op.between';
    case GT:
      return 'boards.op.gt';
    case LT:
      return 'boards.op.lt';
    case CONTAINS:
      return 'boards.op.contains';
    default:
      return 'boards.op.is';
  }
}

/** Operations that take no value (the chip is complete as soon as the op is chosen). */
export function opNeedsValue(op: TaskOp): boolean {
  return op !== EMPTY && op !== NOT_EMPTY;
}

/** Relation values (server tokens). */
export const RELATION_VALUES = ['blocks', 'blocked', 'relates', 'duplicates'] as const;

/** Status type values (server tokens), in board order. */
export const STATUS_TYPE_VALUES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const;

/** Date presets of the value picker: relative tokens the server understands. */
export const DATE_PRESETS: ReadonlyArray<{ value: string; label: MessageKey }> = [
  { value: 'today', label: 'boards.date.today' },
  { value: 'week_end', label: 'boards.date.weekEnd' },
  { value: 'month_end', label: 'boards.date.monthEnd' },
  { value: '+7d', label: 'boards.date.in7' },
  { value: '-7d', label: 'boards.date.ago7' },
  { value: '-30d', label: 'boards.date.ago30' },
];

