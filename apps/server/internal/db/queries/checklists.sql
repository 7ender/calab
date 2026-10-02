-- ADR-0058 §2: named checklists of a task and their items.

-- name: ListTaskChecklists :many
SELECT * FROM task_checklists WHERE task_id = $1 ORDER BY position, id;

-- name: ListTaskChecklistItems :many
-- Every item of a task's checklists (GET /tasks/{id}), grouped by the caller.
SELECT * FROM task_checklist_items WHERE task_id = $1 ORDER BY checklist_id, position, id;

-- name: ListChecklistItems :many
SELECT * FROM task_checklist_items WHERE checklist_id = $1 ORDER BY position, id;

-- name: GetTaskChecklist :one
SELECT * FROM task_checklists WHERE id = $1;

-- name: GetTaskChecklistForUpdate :one
SELECT * FROM task_checklists WHERE id = $1 FOR UPDATE;

-- name: GetChecklistItem :one
SELECT * FROM task_checklist_items WHERE id = $1;

-- name: GetChecklistItemForUpdate :one
SELECT * FROM task_checklist_items WHERE id = $1 FOR UPDATE;

-- name: GetChecklistWorkspace :one
-- The workspace of a checklist (identity route resolution).
SELECT b.workspace_id FROM task_checklists c
JOIN tasks t ON t.id = c.task_id JOIN boards b ON b.id = t.board_id
WHERE c.id = $1;

-- name: GetChecklistItemWorkspace :one
SELECT b.workspace_id FROM task_checklist_items i
JOIN tasks t ON t.id = i.task_id JOIN boards b ON b.id = t.board_id
WHERE i.id = $1;

-- name: CountTaskChecklists :one
SELECT count(*)::integer FROM task_checklists WHERE task_id = $1;

-- name: CountChecklistItems :one
SELECT count(*)::integer FROM task_checklist_items WHERE checklist_id = $1;

-- name: TaskChecklistCounts :one
-- The task's counters (Task.checklist_total / checklist_done).
SELECT count(*)::integer AS total, (count(*) FILTER (WHERE done))::integer AS done
FROM task_checklist_items WHERE task_id = $1;

-- name: CreateTaskChecklist :one
-- position NULL = last. Lock the task row first (GetTaskRowForUpdate): count limit, positions.
INSERT INTO task_checklists (task_id, title, position, created_by)
VALUES (sqlc.arg('task_id'), sqlc.arg('title'),
        coalesce(sqlc.narg('position')::integer,
                 (SELECT coalesce(max(position) + 1, 0) FROM task_checklists WHERE task_id = sqlc.arg('task_id'))),
        sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateTaskChecklist :one
UPDATE task_checklists SET title = coalesce(sqlc.narg('title'), title)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetTaskChecklistPosition :exec
UPDATE task_checklists SET position = $2 WHERE id = $1;

-- name: DeleteTaskChecklist :execrows
DELETE FROM task_checklists WHERE id = $1;

-- name: CreateChecklistItem :one
-- position NULL = after the last item of the checklist.
INSERT INTO task_checklist_items (checklist_id, task_id, text, position, created_by)
VALUES (sqlc.arg('checklist_id'), sqlc.arg('task_id'), sqlc.arg('text'),
        coalesce(sqlc.narg('position')::double precision,
                 (SELECT coalesce(max(position) + 1, 0) FROM task_checklist_items WHERE checklist_id = sqlc.arg('checklist_id'))),
        sqlc.narg('created_by'))
RETURNING *;

-- name: UpdateChecklistItem :one
-- done set: done_by / done_at follow (true = the actor and now, false = cleared); a repeat of
-- the current value keeps them. checklist_id moves the item (same task: checked by the caller).
UPDATE task_checklist_items SET
    text         = coalesce(sqlc.narg('text'), text),
    position     = coalesce(sqlc.narg('position'), position),
    checklist_id = coalesce(sqlc.narg('checklist_id'), checklist_id),
    done_by      = CASE WHEN sqlc.narg('done')::boolean IS NULL OR sqlc.narg('done')::boolean = done THEN done_by
                        WHEN sqlc.narg('done')::boolean THEN sqlc.narg('actor_id')::uuid ELSE NULL END,
    done_at      = CASE WHEN sqlc.narg('done')::boolean IS NULL OR sqlc.narg('done')::boolean = done THEN done_at
                        WHEN sqlc.narg('done')::boolean THEN now() ELSE NULL END,
    done         = coalesce(sqlc.narg('done')::boolean, done)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: DeleteChecklistItem :execrows
DELETE FROM task_checklist_items WHERE id = $1;
