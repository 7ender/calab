-- ADR-0025: GPTunneL integration and meeting recordings.

-- name: GetIntegration :one
SELECT * FROM workspace_integrations WHERE workspace_id = $1 AND kind = $2;

-- name: PutIntegration :one
INSERT INTO workspace_integrations (workspace_id, kind, token_enc, device_id, device_name, account, web_url, paired_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, kind) DO UPDATE
SET token_enc = excluded.token_enc, device_id = excluded.device_id, device_name = excluded.device_name,
    account = excluded.account, web_url = excluded.web_url, paired_by = excluded.paired_by,
    paired_at = now(), revoked_at = NULL
RETURNING *;

-- name: RevokeIntegration :execrows
-- Forgets the token. token_enc = the token being revoked (NULL = any): a token paired again
-- meanwhile is not dropped because the old one was rejected.
UPDATE workspace_integrations SET token_enc = NULL, revoked_at = now()
WHERE workspace_id = $1 AND kind = $2 AND token_enc IS NOT NULL
  AND (sqlc.narg('token_enc')::bytea IS NULL OR token_enc = sqlc.narg('token_enc')::bytea);

-- name: LockRecordings :exec
-- Serializes starts: the concurrent-recordings limit is counted under this lock.
SELECT pg_advisory_xact_lock(hashtext('room_recordings.start'));

-- name: CountActiveRecordings :one
SELECT count(*) FROM room_recordings WHERE status IN ('pending', 'recording');

-- name: InsertRecording :one
INSERT INTO room_recordings (id, workspace_id, room_id, started_by, file)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetRecording :one
SELECT * FROM room_recordings WHERE id = $1;

-- name: GetRecordingByEgress :one
SELECT * FROM room_recordings WHERE egress_id = $1;

-- name: GetActiveRecording :one
SELECT * FROM room_recordings WHERE room_id = $1 AND status IN ('pending', 'recording');

-- name: ListActiveRecordings :many
-- Recordings in progress: all (workspace_id NULL) or of one workspace.
SELECT * FROM room_recordings
WHERE status IN ('pending', 'recording')
  AND (sqlc.narg('workspace_id')::uuid IS NULL OR workspace_id = sqlc.narg('workspace_id')::uuid)
ORDER BY id;

-- name: MarkRecordingStarted :one
UPDATE room_recordings SET status = 'recording', egress_id = $2, started_at = now(), updated_at = now()
WHERE id = $1 AND status = 'pending'
RETURNING *;

-- name: MarkRecordingStopRequested :one
-- The stop is on its way to the recorder; the row stays 'recording' until the recorder ends
-- (webhook / reconcile) and reports the file.
UPDATE room_recordings SET stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN $2 ELSE stop_reason END,
    stopped_by = coalesce(stopped_by, sqlc.narg('stopped_by')::uuid), updated_at = now()
WHERE id = $1 AND status IN ('pending', 'recording')
RETURNING *;

-- name: SetRecordingEmptySince :exec
UPDATE room_recordings SET empty_since = $2 WHERE id = $1 AND status = 'recording';

-- name: MarkRecordingEnded :one
-- The recorder finished with a file: queue the upload.
UPDATE room_recordings SET status = 'uploading', size_bytes = $2, duration_sec = $3,
    stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN $4 ELSE stop_reason END,
    next_at = now(), attempts = 0, error = '', updated_at = now()
WHERE id = $1 AND status IN ('pending', 'recording')
RETURNING *;

-- name: MarkRecordingFailed :one
-- Terminal failure at any stage (the file, if any, is removed by the janitor).
UPDATE room_recordings SET status = 'failed', error = $2, next_at = NULL,
    stopped_at = coalesce(stopped_at, now()), stop_reason = CASE WHEN stop_reason = '' THEN sqlc.arg('stop_reason')::text ELSE stop_reason END,
    updated_at = now()
WHERE id = $1 AND status NOT IN ('done', 'failed')
RETURNING *;

-- name: ClaimRecordingJobs :many
-- Due uploads / status polls; claimed rows are leased (next_at moves one lease ahead), so a
-- crashed worker's jobs are retried later and a second worker skips them.
UPDATE room_recordings SET next_at = now() + sqlc.arg('lease')::interval
WHERE id IN (
    SELECT r.id FROM room_recordings r
    WHERE r.status IN ('uploading', 'processing') AND r.next_at <= now()
    ORDER BY r.next_at
    LIMIT sqlc.arg('lim')
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: SetRecordingGptunnelID :exec
UPDATE room_recordings SET gptunnel_id = $2, updated_at = now() WHERE id = $1;

-- name: RetryRecording :exec
UPDATE room_recordings SET attempts = attempts + 1, next_at = $2, error = $3, updated_at = now()
WHERE id = $1 AND status IN ('uploading', 'processing');

-- name: MarkRecordingProcessing :one
UPDATE room_recordings SET status = 'processing', gptunnel_id = $2, web_url = $3, next_at = $4,
    attempts = 0, error = '', processing_since = now(), updated_at = now()
WHERE id = $1 AND status = 'uploading'
RETURNING *;

-- name: PollRecordingLater :exec
UPDATE room_recordings SET next_at = $2, web_url = CASE WHEN sqlc.arg('web_url')::text <> '' THEN sqlc.arg('web_url')::text ELSE web_url END, updated_at = now()
WHERE id = $1 AND status = 'processing';

-- name: MarkRecordingDone :one
UPDATE room_recordings SET status = 'done', web_url = CASE WHEN sqlc.arg('web_url')::text <> '' THEN sqlc.arg('web_url')::text ELSE web_url END,
    next_at = NULL, error = '', updated_at = now()
WHERE id = sqlc.arg('id') AND status = 'processing'
RETURNING *;

-- name: SetRecordingMessage :exec
UPDATE room_recordings SET message_id = $2 WHERE id = $1;

-- name: ListRecordingFilesToDelete :many
-- Local files no longer needed: done, or failed / stuck and stopped before `before` (7 days).
SELECT * FROM room_recordings
WHERE file <> '' AND file_deleted_at IS NULL
  AND (status = 'done' OR (status NOT IN ('pending', 'recording') AND stopped_at < sqlc.arg('before')))
ORDER BY id
LIMIT 100;

-- name: MarkRecordingFileDeleted :exec
UPDATE room_recordings SET file_deleted_at = now() WHERE id = $1;

-- name: ListStalePendingRecordings :many
-- Rows whose recorder never started (the server died between insert and StartEgress).
SELECT * FROM room_recordings WHERE status = 'pending' AND started_at < sqlc.arg('before');

-- name: InsertSystemMessage :one
INSERT INTO messages (room_id, author_id, content, kind, payload)
VALUES ($1, $2, '', 'system', $3)
RETURNING *;

-- name: UpdateSystemMessage :one
UPDATE messages SET payload = $2 WHERE id = $1 AND kind = 'system' AND deleted_at IS NULL
RETURNING *;
