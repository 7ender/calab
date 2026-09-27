-- ADR-0023: mail outbox and email codes.

-- name: EnqueueMail :one
INSERT INTO mail_outbox (to_addr, template, locale, params, priority, expires_at)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id;

-- name: ClaimMail :many
-- Takes up to `lim` due mails for sending: their next_at moves one lease ahead, so a crashed
-- worker's mails are retried later and a second worker (lock lost) skips them.
UPDATE mail_outbox SET next_at = now() + sqlc.arg('lease')::interval
WHERE id IN (
    SELECT o.id FROM mail_outbox o
    WHERE o.sent_at IS NULL AND o.failed_at IS NULL AND o.next_at <= now()
    ORDER BY o.priority, o.next_at
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: MarkMailSent :exec
UPDATE mail_outbox SET sent_at = now(), params = NULL, error = '' WHERE id = $1;

-- name: MarkMailRetry :exec
UPDATE mail_outbox SET attempts = attempts + 1, next_at = $2, error = $3 WHERE id = $1;

-- name: MarkMailFailed :exec
UPDATE mail_outbox SET attempts = attempts + 1, failed_at = now(), params = NULL, error = $2 WHERE id = $1;

-- name: PostponeMail :exec
-- Server-wide send limit reached: try again later without counting an attempt.
UPDATE mail_outbox SET next_at = $2 WHERE id = $1;

-- name: DeleteOldMail :execrows
DELETE FROM mail_outbox WHERE created_at < $1 AND (sent_at IS NOT NULL OR failed_at IS NOT NULL);

-- name: GetMail :one
SELECT * FROM mail_outbox WHERE id = $1;

-- name: PutEmailCode :one
-- Replaces the code unless the current one was created after resend_before (60 s ago):
-- no row = too soon. Atomic, so two parallel resends cannot both mail a code.
INSERT INTO email_codes (user_id, purpose, code_hash, expires_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, purpose) DO UPDATE
SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = now()
WHERE email_codes.created_at < sqlc.arg('resend_before')
RETURNING *;

-- name: GetEmailCode :one
SELECT * FROM email_codes WHERE user_id = $1 AND purpose = $2;

-- name: TakeEmailCodeAttempt :one
-- Counts one attempt of a live code before it is checked; no row = no usable code.
UPDATE email_codes SET attempts = attempts + 1
WHERE user_id = $1 AND purpose = $2 AND expires_at > now() AND attempts < sqlc.arg('max_attempts')::integer
RETURNING *;

-- name: DeleteEmailCode :exec
DELETE FROM email_codes WHERE user_id = $1 AND purpose = $2;

-- name: DeleteExpiredEmailCodes :execrows
DELETE FROM email_codes WHERE expires_at < $1;
