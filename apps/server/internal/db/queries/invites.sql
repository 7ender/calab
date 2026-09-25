-- name: CreateInvite :one
INSERT INTO workspace_invites (workspace_id, code, created_by, max_uses, expires_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: ListInvites :many
SELECT * FROM workspace_invites WHERE workspace_id = $1 ORDER BY created_at DESC;

-- name: GetInviteByCode :one
SELECT * FROM workspace_invites WHERE code = $1;

-- name: ConsumeInvite :one
-- Atomically takes one use of a valid invite; no row = invalid / expired / used up.
UPDATE workspace_invites SET uses = uses + 1
WHERE code = $1
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses = 0 OR uses < max_uses)
RETURNING *;

-- name: DeleteInvite :execrows
DELETE FROM workspace_invites WHERE id = $1 AND workspace_id = $2;
