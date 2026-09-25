-- name: InsertFile :one
INSERT INTO files (id, workspace_id, uploader_id, key, thumbnail_key, name, mime, size, width, height, sha256)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING *;

-- name: ReserveQuota :one
-- Atomically adds size to the workspace usage if it fits the quota; no row = quota exceeded.
UPDATE workspaces SET storage_used_bytes = storage_used_bytes + sqlc.arg('size')::bigint
WHERE id = sqlc.arg('id') AND storage_used_bytes + sqlc.arg('size')::bigint <= storage_quota_bytes
RETURNING storage_used_bytes;

-- name: ReleaseQuota :exec
UPDATE workspaces SET storage_used_bytes = greatest(0, storage_used_bytes - sqlc.arg('size')::bigint)
WHERE id = sqlc.arg('id');

-- name: GetFile :one
SELECT * FROM files WHERE id = $1;

-- name: GetFilesWithUsage :many
SELECT f.*, EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id) AS attached
FROM files f WHERE f.id = ANY(sqlc.arg('ids')::uuid[]);

-- name: FileRooms :many
-- Rooms where the file is attached to a live message.
SELECT DISTINCT m.room_id FROM message_attachments ma
JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
WHERE ma.file_id = $1;

-- name: IsWorkspaceIcon :one
SELECT EXISTS (SELECT 1 FROM workspaces WHERE icon_file_id = $1);

-- name: ListOrphanFiles :many
-- Not attached, not an avatar or icon, older than the cutoff.
SELECT * FROM files f
WHERE f.created_at < $1
  AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
  AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.icon_file_id = f.id)
ORDER BY f.created_at
LIMIT 500;

-- name: DeleteFile :execrows
DELETE FROM files WHERE id = $1;

-- name: ListWorkspaceFileKeys :many
SELECT key, thumbnail_key FROM files WHERE workspace_id = $1;

-- name: TryAdvisoryXactLock :one
SELECT pg_try_advisory_xact_lock(hashtext(sqlc.arg('name')::text));
