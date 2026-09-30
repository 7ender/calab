-- Web apps of a workspace (ADR-0050).

-- name: LockWorkspaceApps :exec
-- Serializes creation and reordering of one workspace's apps.
SELECT pg_advisory_xact_lock(hashtext('calaba.apps.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListWorkspaceApps :many
SELECT * FROM workspace_apps WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetWorkspaceApp :one
SELECT * FROM workspace_apps WHERE id = $1;

-- name: CountWorkspaceApps :one
SELECT count(*)::integer FROM workspace_apps WHERE workspace_id = $1;

-- name: InsertWorkspaceApp :one
INSERT INTO workspace_apps (workspace_id, name, url, icon_file_id, created_by, position)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('name'), sqlc.arg('url'), sqlc.narg('icon_file_id'), sqlc.arg('created_by'),
        (SELECT coalesce(max(a.position), 0) + 1 FROM workspace_apps a WHERE a.workspace_id = sqlc.arg('workspace_id')))
RETURNING *;

-- name: UpdateWorkspaceApp :one
UPDATE workspace_apps SET
    name         = coalesce(sqlc.narg('name'), name),
    url          = coalesce(sqlc.narg('url'), url),
    icon_file_id = CASE WHEN sqlc.arg('set_icon')::boolean THEN sqlc.narg('icon_file_id')::uuid ELSE icon_file_id END,
    updated_at   = now()
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetWorkspaceAppPosition :one
UPDATE workspace_apps SET position = $2, updated_at = now() WHERE id = $1
RETURNING *;

-- name: DeleteWorkspaceApp :execrows
DELETE FROM workspace_apps WHERE id = $1;

-- name: IsWorkspaceAppIcon :one
-- The file is the icon of a web app (files.CanRead: members of its workspace).
SELECT EXISTS (SELECT 1 FROM workspace_apps WHERE icon_file_id = $1)::boolean;
