-- ADR-0046: SIP telephony — the provider account and the call journal.

-- name: LockSipAccount :exec
-- Serializes saves of one workspace's settings (LiveKit trunk create / replace / delete).
SELECT pg_advisory_xact_lock(hashtext('calaba.sip.' || sqlc.arg('workspace_id')::uuid::text));

-- name: GetSipAccount :one
SELECT * FROM sip_accounts WHERE workspace_id = $1;

-- name: PutSipAccount :one
INSERT INTO sip_accounts (workspace_id, provider, host, transport, username, password_enc, caller_id,
                          outbound_prefix, allowed_prefixes, trunk_id, enabled, last_error, updated_at, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '', now(), $12)
ON CONFLICT (workspace_id) DO UPDATE
SET provider = excluded.provider, host = excluded.host, transport = excluded.transport,
    username = excluded.username, password_enc = excluded.password_enc, caller_id = excluded.caller_id,
    outbound_prefix = excluded.outbound_prefix, allowed_prefixes = excluded.allowed_prefixes,
    trunk_id = excluded.trunk_id, enabled = excluded.enabled, last_error = '',
    updated_at = now(), updated_by = excluded.updated_by
RETURNING *;

-- name: SetSipLastError :exec
-- A refused save or a failed connection test: only last_error changes ('' clears it).
INSERT INTO sip_accounts (workspace_id, last_error) VALUES ($1, $2)
ON CONFLICT (workspace_id) DO UPDATE SET last_error = excluded.last_error;

-- name: SetWorkspaceSipEnabled :one
UPDATE workspaces SET sip_enabled = $2 WHERE id = $1 RETURNING *;

-- name: InsertSipCall :one
INSERT INTO sip_calls (id, workspace_id, room_id, number, direction, started_by, participant_identity)
VALUES ($1, $2, $3, $4, 'out', $5, $6)
RETURNING *;

-- name: GetSipCall :one
SELECT * FROM sip_calls WHERE id = $1;

-- name: GetLiveSipCallByRoom :one
SELECT * FROM sip_calls WHERE room_id = $1 AND status IN ('dialing', 'ringing', 'active');

-- name: ListLiveSipCallsByWorkspace :many
-- WorkspaceSnapshot.sip_calls: the live calls of the workspace's rooms.
SELECT * FROM sip_calls
WHERE workspace_id = $1 AND room_id IS NOT NULL AND status IN ('dialing', 'ringing', 'active')
ORDER BY id;

-- name: ListLiveSipCalls :many
-- The sweeper: live calls placed before the cutoff, oldest first.
SELECT * FROM sip_calls
WHERE status IN ('dialing', 'ringing', 'active') AND started_at < $1
ORDER BY started_at
LIMIT 200;

-- name: MarkSipCallRinging :one
UPDATE sip_calls SET status = 'ringing'
WHERE id = $1 AND status = 'dialing'
RETURNING *;

-- name: MarkSipCallActive :one
UPDATE sip_calls
SET status = 'active', answered_at = coalesce(answered_at, now()),
    sip_call_id = CASE WHEN sqlc.arg('sip_call_id')::text <> '' THEN sqlc.arg('sip_call_id')::text ELSE sip_call_id END
WHERE id = sqlc.arg('id') AND status IN ('dialing', 'ringing')
RETURNING *;

-- name: FinishSipCall :one
-- ENDED / FAILED once: a call that is already final is left as it is (no row).
UPDATE sip_calls
SET status = sqlc.arg('status'), reason = sqlc.arg('reason'), ended_by = sqlc.narg('ended_by'), ended_at = now(),
    sip_call_id = CASE WHEN sqlc.arg('sip_call_id')::text <> '' THEN sqlc.arg('sip_call_id')::text ELSE sip_call_id END
WHERE id = sqlc.arg('id') AND status IN ('dialing', 'ringing', 'active')
RETURNING *;

-- name: ListSipCalls :many
-- The journal, newest first; from / to bound started_at, cursor = the last id of the previous page.
SELECT * FROM sip_calls
WHERE workspace_id = sqlc.arg('workspace_id')
  AND (sqlc.narg('from')::timestamptz IS NULL OR started_at >= sqlc.narg('from')::timestamptz)
  AND (sqlc.narg('to')::timestamptz IS NULL OR started_at < sqlc.narg('to')::timestamptz)
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');
