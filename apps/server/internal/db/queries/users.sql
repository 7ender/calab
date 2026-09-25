-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: CreateUser :one
INSERT INTO users (email, password_hash, display_name)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE email = $1;

-- name: UpdateUser :one
UPDATE users SET
    display_name   = coalesce(sqlc.narg('display_name'), display_name),
    status_text    = coalesce(sqlc.narg('status_text'), status_text),
    avatar_file_id = CASE WHEN sqlc.arg('set_avatar')::boolean THEN sqlc.narg('avatar_file_id')::uuid ELSE avatar_file_id END,
    settings       = coalesce(sqlc.narg('settings'), settings)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: LockRegistration :exec
-- Serializes the first-user bootstrap check (see auth.Register).
SELECT pg_advisory_xact_lock(hashtext('calaba.registration'));
