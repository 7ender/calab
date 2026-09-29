-- Camera backgrounds of a workspace (ADR-0035).

-- name: LockWorkspaceBackgrounds :exec
-- Serializes background creation of one workspace between the count and the insert.
SELECT pg_advisory_xact_lock(hashtext('calaba.backgrounds.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListWorkspaceBackgrounds :many
SELECT * FROM workspace_backgrounds WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetWorkspaceBackground :one
SELECT * FROM workspace_backgrounds WHERE id = $1 AND workspace_id = $2;

-- name: CountWorkspaceBackgrounds :one
SELECT count(*)::integer FROM workspace_backgrounds WHERE workspace_id = $1;

-- name: InsertWorkspaceBackground :one
INSERT INTO workspace_backgrounds (workspace_id, name, file_id, position)
VALUES ($1, $2, $3, (SELECT coalesce(max(b.position), -1) + 1 FROM workspace_backgrounds b WHERE b.workspace_id = $1)::smallint)
RETURNING *;

-- name: RenameWorkspaceBackground :one
UPDATE workspace_backgrounds SET name = $3
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: DeleteWorkspaceBackground :execrows
DELETE FROM workspace_backgrounds WHERE id = $1 AND workspace_id = $2;

-- name: IsWorkspaceBackground :one
-- The file is the picture of a camera background (files.CanRead: members of its workspace).
SELECT EXISTS (SELECT 1 FROM workspace_backgrounds WHERE file_id = $1)::boolean;
