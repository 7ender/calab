-- Guest admission (ADR-0040).

-- name: GetAdmissionForUpdate :one
SELECT * FROM room_admissions WHERE room_id = $1 AND user_id = $2 FOR UPDATE;

-- name: LockRoomAdmissions :exec
-- Serializes knocks on one room between the pending count and the insert (limit 50).
SELECT pg_advisory_xact_lock(hashtext('calaba.admissions:' || sqlc.arg('room_id')::uuid::text));

-- name: CountPendingAdmissions :one
SELECT count(*)::integer FROM room_admissions WHERE room_id = $1 AND status = 'pending';

-- name: UpsertPendingAdmission :one
-- A new knock (or a knock again after a decline): pending from requested_at.
INSERT INTO room_admissions (room_id, user_id, invite_id, status, requested_at)
VALUES (sqlc.arg('room_id'), sqlc.arg('user_id'), sqlc.narg('invite_id'), 'pending', sqlc.arg('requested_at'))
ON CONFLICT (room_id, user_id) DO UPDATE
    SET invite_id = EXCLUDED.invite_id, status = 'pending', requested_at = EXCLUDED.requested_at,
        decided_by = NULL, decided_at = NULL
RETURNING *;

-- name: DeclineAdmission :one
UPDATE room_admissions SET status = 'declined', decided_by = sqlc.narg('decided_by'), decided_at = sqlc.arg('decided_at')::timestamptz
WHERE room_id = sqlc.arg('room_id') AND user_id = sqlc.arg('user_id') AND status = 'pending'
RETURNING *;

-- name: DeleteAdmission :execrows
DELETE FROM room_admissions WHERE room_id = $1 AND user_id = $2;

-- name: ListRoomPendingAdmissions :many
-- The room's pending knocks with the knocking users, oldest first (≤ 50 by the knock limit).
SELECT sqlc.embed(a), sqlc.embed(u), i.created_by AS invite_created_by
FROM room_admissions a
JOIN users u ON u.id = a.user_id
LEFT JOIN room_invites i ON i.id = a.invite_id
WHERE a.room_id = $1 AND a.status = 'pending'
ORDER BY a.requested_at, a.user_id;

-- name: ListUserAdmissions :many
-- The user's own knocks (READY): pending, and declined ones still kept, with the room and
-- workspace names for the waiting screen.
SELECT sqlc.embed(a), r.name AS room_name, r.workspace_id AS workspace_id, w.name AS workspace_name
FROM room_admissions a
JOIN rooms r ON r.id = a.room_id AND r.archived_at IS NULL
JOIN workspaces w ON w.id = r.workspace_id
WHERE a.user_id = $1 AND a.status IN ('pending', 'declined')
ORDER BY a.requested_at;

-- name: ListWorkspacesPendingAdmissions :many
-- Pending knocks in the given workspaces (READY of a decider; filtered by the caller).
SELECT sqlc.embed(a), sqlc.embed(u), r.workspace_id AS workspace_id, i.created_by AS invite_created_by
FROM room_admissions a
JOIN users u ON u.id = a.user_id
JOIN rooms r ON r.id = a.room_id AND r.archived_at IS NULL
LEFT JOIN room_invites i ON i.id = a.invite_id
WHERE r.workspace_id = ANY(sqlc.arg('workspace_ids')::uuid[]) AND a.status = 'pending'
ORDER BY a.requested_at, a.user_id;

-- name: DeclineStaleAdmissions :many
-- Sweeper: pending knocks older than the cutoff are declined with nobody deciding.
UPDATE room_admissions a SET status = 'declined', decided_at = sqlc.arg('now')::timestamptz
FROM (
    SELECT s.room_id, s.user_id FROM room_admissions s
    WHERE s.status = 'pending' AND s.requested_at < sqlc.arg('cutoff')::timestamptz
    ORDER BY s.requested_at
    LIMIT 200
    FOR UPDATE SKIP LOCKED) stale
WHERE a.room_id = stale.room_id AND a.user_id = stale.user_id
RETURNING a.*;

-- name: DeleteExpiredDeclines :execrows
DELETE FROM room_admissions WHERE status = 'declined' AND decided_at < sqlc.arg('cutoff')::timestamptz;

-- name: RefundRoomInviteUse :exec
-- A knock that did not end in admission gives its use of the link back.
UPDATE room_invites SET uses = greatest(uses - 1, 0) WHERE id = $1;

-- name: GuestHasOtherAccess :one
-- Whether a guest keeps a reason to stay in the workspace besides this room: a personal
-- override in another live room, or a pending knock on another room.
SELECT (EXISTS (
    SELECT 1 FROM room_permissions p JOIN rooms r ON r.id = p.room_id
    WHERE r.workspace_id = sqlc.arg('workspace_id')::uuid AND r.archived_at IS NULL AND r.id <> sqlc.arg('room_id')
      AND p.target_type = 'user' AND p.target_id = sqlc.arg('user_id')::uuid::text
) OR EXISTS (
    SELECT 1 FROM room_admissions a JOIN rooms r ON r.id = a.room_id
    WHERE r.workspace_id = sqlc.arg('workspace_id')::uuid AND a.room_id <> sqlc.arg('room_id')
      AND a.user_id = sqlc.arg('user_id') AND a.status = 'pending'
))::boolean;

-- name: RemoveGuestMember :execrows
-- Only a guest membership goes (a promoted member stays).
DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'guest';

-- name: SetGuestDisplayName :one
UPDATE users SET display_name = $2 WHERE id = $1 AND is_guest RETURNING *;

-- name: CountUserRoomInvites :one
-- Links of the room made by the user (they may decide on the knocks by them).
SELECT count(*)::integer FROM room_invites WHERE room_id = $1 AND created_by = $2;
