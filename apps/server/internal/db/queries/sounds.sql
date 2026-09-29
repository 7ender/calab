-- Soundboard of a workspace (ADR-0036).

-- name: LockWorkspaceSounds :exec
-- Serializes changes of one workspace's library (count + insert, reorder).
SELECT pg_advisory_xact_lock(hashtext('calaba.sounds.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListWorkspaceSounds :many
SELECT * FROM workspace_sounds WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetWorkspaceSound :one
SELECT * FROM workspace_sounds WHERE id = $1 AND workspace_id = $2;

-- name: CountWorkspaceSounds :one
SELECT count(*)::integer FROM workspace_sounds WHERE workspace_id = $1;

-- name: InsertWorkspaceSound :one
INSERT INTO workspace_sounds (workspace_id, name, emoji, file_id, duration_ms, position)
VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(s.position), -1) + 1 FROM workspace_sounds s WHERE s.workspace_id = $1)::smallint)
RETURNING *;

-- name: UpdateWorkspaceSound :one
UPDATE workspace_sounds SET name = $3, emoji = $4, file_id = $5, duration_ms = $6
WHERE id = $1 AND workspace_id = $2
RETURNING *;

-- name: SetWorkspaceSoundPosition :exec
UPDATE workspace_sounds SET position = $3 WHERE id = $1 AND workspace_id = $2;

-- name: DeleteWorkspaceSound :execrows
DELETE FROM workspace_sounds WHERE id = $1 AND workspace_id = $2;

-- name: IsWorkspaceSound :one
-- The file is the clip of a sound (files.CanRead: members of its workspace).
SELECT EXISTS (SELECT 1 FROM workspace_sounds WHERE file_id = $1)::boolean;
