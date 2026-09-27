-- name: CountUsers :one
SELECT count(*) FROM users;

-- name: CreateUser :one
INSERT INTO users (email, password_hash, display_name, settings, locale, email_verified_at)
VALUES ($1, $2, $3, $4, $5, $6)
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
    settings       = coalesce(sqlc.narg('settings'), settings),
    timezone       = CASE WHEN sqlc.arg('set_timezone')::boolean THEN sqlc.narg('timezone')::text ELSE timezone END,
    locale         = CASE WHEN sqlc.arg('set_locale')::boolean THEN sqlc.narg('locale')::text ELSE locale END
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: LockRegistration :exec
-- Serializes the first-user bootstrap check (see auth.Register).
SELECT pg_advisory_xact_lock(hashtext('calaba.registration'));

-- name: UpdateStatus :one
UPDATE users SET status_text = $2, status_emoji = $3, status_expires_at = $4
WHERE id = $1
RETURNING *;

-- name: SetPasswordHash :exec
UPDATE users SET password_hash = $2 WHERE id = $1;

-- name: SetEmail :one
UPDATE users SET email = $2 WHERE id = $1
RETURNING *;

-- name: LockPasswordHash :one
-- Login re-reads the hash under a share lock in the session transaction: a concurrent
-- password change either waits for the new session (and then revokes it) or has already
-- replaced the hash (and the login fails).
SELECT password_hash FROM users WHERE id = $1 FOR SHARE;

-- name: SetEmailVerified :one
-- Marks the current address verified (no-op if it already is).
UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1
RETURNING *;

-- name: SetPendingEmail :one
UPDATE users SET pending_email = $2 WHERE id = $1
RETURNING *;

-- name: ConfirmPendingEmail :one
-- The confirmed pending address becomes the login email (unique: may fail with 23505).
UPDATE users SET email = pending_email, pending_email = NULL, email_verified_at = now()
WHERE id = $1 AND pending_email IS NOT NULL
RETURNING *;

-- name: SetEmailAndVerified :one
-- Servers without SMTP: an email change takes effect at once (nothing to verify with).
UPDATE users SET email = $2, pending_email = NULL, email_verified_at = now() WHERE id = $1
RETURNING *;
