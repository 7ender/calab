-- Member badges (docs/09 #82).

-- name: LockWorkspaceBadges :exec
-- Serializes badge creation of one workspace between the count and the insert.
SELECT pg_advisory_xact_lock(hashtext('calaba.badges.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListWorkspaceBadges :many
SELECT * FROM workspace_badges WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetWorkspaceBadge :one
SELECT * FROM workspace_badges WHERE id = $1 AND workspace_id = $2;

-- name: CountWorkspaceBadges :one
SELECT count(*)::integer FROM workspace_badges WHERE workspace_id = $1;

-- name: InsertWorkspaceBadge :one
INSERT INTO workspace_badges (workspace_id, name, file_id, position)
VALUES ($1, $2, $3, (SELECT coalesce(max(b.position), -1) + 1 FROM workspace_badges b WHERE b.workspace_id = $1)::smallint)
RETURNING *;

-- name: UpdateWorkspaceBadge :one
UPDATE workspace_badges SET
    name    = coalesce(sqlc.narg('name'), name),
    file_id = coalesce(sqlc.narg('file_id'), file_id)
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: ClearBadgeFromMembers :many
-- The members that had the badge, now without it (before the badge row goes).
UPDATE workspace_members SET badge_id = NULL WHERE badge_id = $1
RETURNING *;

-- name: DeleteWorkspaceBadge :execrows
DELETE FROM workspace_badges WHERE id = $1 AND workspace_id = $2;

-- name: SetMemberBadge :one
UPDATE workspace_members SET badge_id = sqlc.narg('badge_id')
WHERE workspace_id = sqlc.arg('workspace_id') AND user_id = sqlc.arg('user_id')
RETURNING *;

-- name: IsWorkspaceBadge :one
-- The file is the picture of a badge (files.CanRead: members of its workspace).
SELECT EXISTS (SELECT 1 FROM workspace_badges WHERE file_id = $1)::boolean;
