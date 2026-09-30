-- name: LockInteractionNonce :exec
-- Serialize a caller's retries, including across messages, before locking the message.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg('key')::text, 45));

-- name: GetInteraction :one
SELECT * FROM message_interactions WHERE user_id = $1 AND nonce = $2;

-- name: InsertInteraction :one
INSERT INTO message_interactions (message_id, user_id, nonce, button_id, keyboard_revision)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: GetMessageForInteraction :one
-- Text/keyboard edits and soft deletion take the same row lock.
SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE;
