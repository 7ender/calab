-- Private user notes (docs/09 item 20): only the author reads and writes them.

-- name: GetUserNote :one
SELECT * FROM user_notes WHERE author_id = $1 AND subject_id = $2;

-- name: UpsertUserNote :one
INSERT INTO user_notes (author_id, subject_id, text)
VALUES ($1, $2, $3)
ON CONFLICT (author_id, subject_id) DO UPDATE SET text = excluded.text, updated_at = now()
RETURNING *;

-- name: DeleteUserNote :exec
DELETE FROM user_notes WHERE author_id = $1 AND subject_id = $2;

-- name: CanSeeUser :one
-- The subject is the user, shares a workspace with them (any role) or a DM: who may keep a
-- note about whom. Disabled accounts are still visible (their messages stay).
SELECT (
    sqlc.arg('user_id')::uuid = sqlc.arg('subject_id')::uuid
    OR EXISTS (
        SELECT 1 FROM workspace_members a
        JOIN workspace_members b ON b.workspace_id = a.workspace_id AND b.user_id = sqlc.arg('subject_id')
        WHERE a.user_id = sqlc.arg('user_id'))
    OR EXISTS (
        SELECT 1 FROM dm_members a
        JOIN dm_members b ON b.room_id = a.room_id AND b.user_id = sqlc.arg('subject_id')
        WHERE a.user_id = sqlc.arg('user_id'))
)::boolean;

-- name: DeleteNotesAbout :exec
-- Guest anonymization (ADR-0016): notes written by the user and about them.
DELETE FROM user_notes WHERE author_id = sqlc.arg('user_id') OR subject_id = sqlc.arg('user_id');
