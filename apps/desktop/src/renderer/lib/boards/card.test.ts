import { create } from '@bufbuild/protobuf';
import { BoardSchema, BoardStatusSchema, BoardStatusType, TaskAssigneeSchema, TaskSchema, UnfurlResponseSchema } from '@calaba/protocol';
import { describe, expect, it } from 'vitest';
import { linkCard } from './card';

const board = create(BoardSchema, {
  id: 'b1',
  workspaceId: 'w1',
  name: 'Разработка',
  key: 'CAL',
  emoji: '🛠️',
  openTasks: 7,
  statuses: [
    create(BoardStatusSchema, { id: 's1', name: 'В работе', type: BoardStatusType.STARTED, color: 0xffcc00 }),
    create(BoardStatusSchema, { id: 's2', name: 'Готово', type: BoardStatusType.COMPLETED, color: 0x30d158 }),
  ],
});
const a = (userId: string, isLead = false) => create(TaskAssigneeSchema, { userId, isLead });
const task = create(TaskSchema, {
  id: 't1',
  boardId: 'b1',
  workspaceId: 'w1',
  key: 'CAL-4',
  title: 'Карточки задач в чате',
  statusId: 's1',
  dueOn: '2026-01-15',
  assignees: [a('u1'), a('u2', true), a('u3'), a('u4'), a('u5')],
});

describe('linkCard', () => {
  it('maps a task unfurl: key, title, status, due, lead first, three avatars + the rest', () => {
    const c = linkCard(create(UnfurlResponseSchema, { task, board }));
    expect(c).toMatchObject({ kind: 'task', id: 't1', key: 'CAL-4', title: 'Карточки задач в чате', statusName: 'В работе', statusType: BoardStatusType.STARTED, statusColor: 0xffcc00, done: false, dueOn: '2026-01-15', boardName: 'Разработка', workspaceId: 'w1' });
    expect(c?.kind === 'task' && c.assignees).toEqual(['u2', 'u1', 'u3']);
    expect(c?.kind === 'task' && c.more).toBe(2);
  });

  it('prefers the live task (a status change after the unfurl was cached)', () => {
    const live = create(TaskSchema, { ...task, statusId: 's2' });
    const c = linkCard(create(UnfurlResponseSchema, { task, board }), { task: live, board });
    expect(c).toMatchObject({ statusName: 'Готово', done: true });
  });

  it('maps a board unfurl, nothing for a plain web card', () => {
    expect(linkCard(create(UnfurlResponseSchema, { board }))).toEqual({ kind: 'board', id: 'b1', workspaceId: 'w1', name: 'Разработка', emoji: '🛠️', key: 'CAL', openTasks: 7 });
    expect(linkCard(create(UnfurlResponseSchema, { title: 'Example' }))).toBeNull();
  });
});
