import { toJson, type MessageInitShape } from '@bufbuild/protobuf';
import {
  BoardPermissionsResponseSchema,
  BoardResponseSchema,
  BoardViewResponseSchema,
  CreateBoardLabelRequestSchema,
  CreateBoardMilestoneRequestSchema,
  CreateBoardRequestSchema,
  CreateBoardStatusRequestSchema,
  CreateBoardViewRequestSchema,
  CreateTaskRequestSchema,
  ListBoardsResponseSchema,
  ListTasksResponseSchema,
  MyTasksResponseSchema,
  SearchTasksResponseSchema,
  SetAssigneesRequestSchema,
  SetBoardPermissionsRequestSchema,
  SetBoardPositionRequestSchema,
  SetTaskRelationRequestSchema,
  SetTaskSubscriptionRequestSchema,
  TaskActivityPageSchema,
  TaskFilterSchema,
  TaskResponseSchema,
  UpdateBoardLabelRequestSchema,
  UpdateBoardMilestoneRequestSchema,
  UpdateBoardRequestSchema,
  UpdateBoardStatusRequestSchema,
  UpdateBoardViewRequestSchema,
  UpdateTaskRequestSchema,
  type TaskAssigneeInput,
  type TaskFilter,
  type TaskRelationKind,
} from '@calaba/protocol';
import { body, call, callEmpty, qs } from '../lib/api/client';

/**
 * Task boards REST (ADR-0042 §3, proto/calaba/v1/boards.proto). The one module that knows the
 * routes and request shapes of the boards contract: the rest of the client imports the entity
 * types from `@calaba/protocol` and calls these. Bodies are protojson through the generated
 * schemas (CLAUDE.md: no hand-written contract types).
 */

/** `?filter=`: the TaskFilter as protojson (one object for server, client, views and bots). */
export function filterParam(f: TaskFilter | undefined): string | undefined {
  if (!f || f.conditions.length === 0) return undefined;
  return JSON.stringify(toJson(TaskFilterSchema, f));
}

export type TaskScope = 'assigned' | 'lead' | 'created' | 'subscribed';

type AssigneeInit = Pick<TaskAssigneeInput, 'userId' | 'isLead' | 'note'>;

export const boardsApi = {
  list: (workspaceId: string, archived = false) =>
    call('GET', `/api/workspaces/${workspaceId}/boards${qs({ archived: archived ? 1 : undefined })}`, ListBoardsResponseSchema),
  /** MANAGE_WORKSPACE; 409 PLAN_LIMIT / BOARD_LIMIT, 409 CONFLICT field key (taken). */
  create: (workspaceId: string, init: MessageInitShape<typeof CreateBoardRequestSchema>) =>
    call('POST', `/api/workspaces/${workspaceId}/boards`, BoardResponseSchema, body(CreateBoardRequestSchema, init)),
  /** With the caller's personal views. */
  get: (boardId: string, signal?: AbortSignal) => call('GET', `/api/boards/${boardId}`, BoardResponseSchema, undefined, signal),
  update: (boardId: string, init: MessageInitShape<typeof UpdateBoardRequestSchema>) =>
    call('PATCH', `/api/boards/${boardId}`, BoardResponseSchema, body(UpdateBoardRequestSchema, init)),
  /** Archive; `purge` deletes for good (MANAGE_BOARD, people only). */
  remove: (boardId: string, purge = false) => callEmpty('DELETE', `/api/boards/${boardId}${qs({ purge: purge ? 1 : undefined })}`),
  /** Back from the archive (MANAGE_BOARD). */
  restore: (boardId: string) => call('POST', `/api/boards/${boardId}/restore`, BoardResponseSchema),
  move: (boardId: string, position: number) =>
    call('PUT', `/api/boards/${boardId}/position`, BoardResponseSchema, body(SetBoardPositionRequestSchema, { position })),
  permissions: (boardId: string) => call('GET', `/api/boards/${boardId}/permissions`, BoardPermissionsResponseSchema),
  setPermissions: (boardId: string, init: MessageInitShape<typeof SetBoardPermissionsRequestSchema>) =>
    call('PUT', `/api/boards/${boardId}/permissions`, BoardPermissionsResponseSchema, body(SetBoardPermissionsRequestSchema, init)),

  statuses: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardStatusRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/statuses`, BoardResponseSchema, body(CreateBoardStatusRequestSchema, init)),
    update: (boardId: string, statusId: string, init: MessageInitShape<typeof UpdateBoardStatusRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/statuses/${statusId}`, BoardResponseSchema, body(UpdateBoardStatusRequestSchema, init)),
    /** The status's tasks move to `moveTo` first; the default status cannot be deleted. */
    remove: (boardId: string, statusId: string, moveTo: string) => callEmpty('DELETE', `/api/boards/${boardId}/statuses/${statusId}${qs({ move_to: moveTo })}`),
  },
  labels: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardLabelRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/labels`, BoardResponseSchema, body(CreateBoardLabelRequestSchema, init)),
    update: (boardId: string, labelId: string, init: MessageInitShape<typeof UpdateBoardLabelRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/labels/${labelId}`, BoardResponseSchema, body(UpdateBoardLabelRequestSchema, init)),
    remove: (boardId: string, labelId: string) => callEmpty('DELETE', `/api/boards/${boardId}/labels/${labelId}`),
  },
  milestones: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardMilestoneRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/milestones`, BoardResponseSchema, body(CreateBoardMilestoneRequestSchema, init)),
    update: (boardId: string, milestoneId: string, init: MessageInitShape<typeof UpdateBoardMilestoneRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/milestones/${milestoneId}`, BoardResponseSchema, body(UpdateBoardMilestoneRequestSchema, init)),
    remove: (boardId: string, milestoneId: string) => callEmpty('DELETE', `/api/boards/${boardId}/milestones/${milestoneId}`),
  },
  views: {
    create: (boardId: string, init: MessageInitShape<typeof CreateBoardViewRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/views`, BoardViewResponseSchema, body(CreateBoardViewRequestSchema, init)),
    update: (boardId: string, viewId: string, init: MessageInitShape<typeof UpdateBoardViewRequestSchema>) =>
      call('PATCH', `/api/boards/${boardId}/views/${viewId}`, BoardViewResponseSchema, body(UpdateBoardViewRequestSchema, init)),
    remove: (boardId: string, viewId: string) => callEmpty('DELETE', `/api/boards/${boardId}/views/${viewId}`),
  },

  tasks: {
    /** One page (≤ 500, by status then position); the client loads a board page by page. */
    list: (boardId: string, p: { filter?: TaskFilter; cursor?: string; archived?: boolean } = {}, signal?: AbortSignal) =>
      call(
        'GET',
        `/api/boards/${boardId}/tasks${qs({ filter: filterParam(p.filter), cursor: p.cursor, archived: p.archived ? 1 : undefined })}`,
        ListTasksResponseSchema,
        undefined,
        signal,
      ),
    create: (boardId: string, init: MessageInitShape<typeof CreateTaskRequestSchema>) =>
      call('POST', `/api/boards/${boardId}/tasks`, TaskResponseSchema, body(CreateTaskRequestSchema, init)),
    /** With subtasks, related tasks, the parent and the task room. */
    get: (taskId: string, signal?: AbortSignal) => call('GET', `/api/tasks/${taskId}`, TaskResponseSchema, undefined, signal),
    /** `/t/<KEY-N>` deep links (+ the board). */
    byKey: (key: string) => call('GET', `/api/t/${encodeURIComponent(key)}`, TaskResponseSchema),
    update: (taskId: string, init: MessageInitShape<typeof UpdateTaskRequestSchema>) =>
      call('PATCH', `/api/tasks/${taskId}`, TaskResponseSchema, body(UpdateTaskRequestSchema, init)),
    archive: (taskId: string) => call('POST', `/api/tasks/${taskId}/archive`, TaskResponseSchema),
    restore: (taskId: string) => call('POST', `/api/tasks/${taskId}/restore`, TaskResponseSchema),
    /** The full list; exactly one lead when not empty. */
    setAssignees: (taskId: string, assignees: AssigneeInit[]) =>
      call('PUT', `/api/tasks/${taskId}/assignees`, TaskResponseSchema, body(SetAssigneesRequestSchema, { assignees })),
    setRelation: (taskId: string, relatedId: string, kind: TaskRelationKind) =>
      call('PUT', `/api/tasks/${taskId}/relations`, TaskResponseSchema, body(SetTaskRelationRequestSchema, { relatedId, kind })),
    removeRelation: (taskId: string, relatedId: string, kind: TaskRelationKind) =>
      call('DELETE', `/api/tasks/${taskId}/relations${qs({ related_id: relatedId, kind })}`, TaskResponseSchema),
    /** muted false = subscribed with notifications, true = «Отписаться». */
    setSubscription: (taskId: string, muted: boolean) =>
      call('PUT', `/api/tasks/${taskId}/subscription`, TaskResponseSchema, body(SetTaskSubscriptionRequestSchema, { muted })),
    /** Clears Task.unread (the boards badge). */
    markRead: (taskId: string) => callEmpty('PUT', `/api/tasks/${taskId}/read`),
    /** The feed: comments and journal rows, newest first; `before` = the oldest id seen. */
    activity: (taskId: string, p: { before?: string; limit?: number } = {}, signal?: AbortSignal) =>
      call('GET', `/api/tasks/${taskId}/activity${qs({ before: p.before, limit: p.limit })}`, TaskActivityPageSchema, undefined, signal),
    /** ⌘K: live tasks of every board the caller sees, by key and words. */
    search: (workspaceId: string, q: string, signal?: AbortSignal) =>
      call('GET', `/api/workspaces/${workspaceId}/tasks/search${qs({ q })}`, SearchTasksResponseSchema, undefined, signal),
    mine: (workspaceId: string, scope: TaskScope, open = true, signal?: AbortSignal) =>
      call('GET', `/api/me/tasks${qs({ workspace_id: workspaceId, scope, open: open ? 1 : undefined })}`, MyTasksResponseSchema, undefined, signal),
  },

  /** Where description / comment attachments of a board's tasks are uploaded. */
  uploadPath: (boardId: string): string => `/api/boards/${boardId}/files`,
};
