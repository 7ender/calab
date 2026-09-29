-- name: CreateSession :one
INSERT INTO sessions (user_id, refresh_token_hash, device_name, ip, user_agent, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetSessionForUpdate :one
SELECT * FROM sessions WHERE id = $1 FOR UPDATE;

-- name: GetSession :one
SELECT * FROM sessions WHERE id = $1;

-- name: RotateSession :one
UPDATE sessions SET
    prev_refresh_token_hash = refresh_token_hash,
    refresh_token_hash      = $2,
    rotated_at              = now(),
    last_seen_at            = now(),
    expires_at              = $3,
    ip                      = $4,
    user_agent              = $5
WHERE id = $1
RETURNING *;

-- name: TouchSession :exec
-- "Last activity" of a session between refreshes (access tokens live 24 h): bumped by the
-- periodic session recheck (auth/sessioncheck.go), at most every 5 minutes.
UPDATE sessions SET last_seen_at = now()
WHERE id = $1 AND revoked_at IS NULL AND last_seen_at < now() - interval '5 minutes';

-- name: RevokeSession :execrows
UPDATE sessions SET revoked_at = now()
WHERE id = $1 AND revoked_at IS NULL;

-- name: RevokeUserSession :execrows
UPDATE sessions SET revoked_at = now()
WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :many
UPDATE sessions SET revoked_at = now()
WHERE user_id = $1 AND revoked_at IS NULL
RETURNING id;

-- name: ListActiveSessions :many
SELECT * FROM sessions
WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
ORDER BY last_seen_at DESC;

-- name: RevokeOtherUserSessions :many
UPDATE sessions SET revoked_at = now()
WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL
RETURNING id;
