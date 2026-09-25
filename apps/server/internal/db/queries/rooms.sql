-- name: CreateRoom :one
INSERT INTO rooms (workspace_id, type, name, topic, position, is_private,
                   audio_bitrate_kbps, max_stream_preset, max_streams)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('type'), sqlc.arg('name'), sqlc.arg('topic'),
        coalesce(sqlc.narg('position')::integer,
                 (SELECT coalesce(max(position) + 1, 0) FROM rooms
                  WHERE workspace_id = sqlc.arg('workspace_id') AND archived_at IS NULL)),
        sqlc.arg('is_private'), sqlc.narg('audio_bitrate_kbps'), sqlc.narg('max_stream_preset'),
        sqlc.narg('max_streams'))
RETURNING *;

-- name: GetRoom :one
SELECT * FROM rooms WHERE id = $1 AND archived_at IS NULL;

-- name: ListRooms :many
SELECT * FROM rooms
WHERE workspace_id = $1 AND archived_at IS NULL
ORDER BY position, id;

-- name: UpdateRoom :one
UPDATE rooms SET
    name     = coalesce(sqlc.narg('name'), name),
    topic    = coalesce(sqlc.narg('topic'), topic),
    position = coalesce(sqlc.narg('position'), position),
    audio_bitrate_kbps = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('audio_bitrate_kbps')::integer ELSE audio_bitrate_kbps END,
    max_stream_preset  = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('max_stream_preset')::text ELSE max_stream_preset END,
    max_streams        = CASE WHEN sqlc.arg('set_media')::boolean THEN sqlc.narg('max_streams')::integer ELSE max_streams END
WHERE id = sqlc.arg('id') AND archived_at IS NULL
RETURNING *;

-- name: ArchiveRoom :execrows
UPDATE rooms SET archived_at = now() WHERE id = $1 AND archived_at IS NULL;

-- name: ListRoomOverrides :many
SELECT * FROM room_permissions WHERE room_id = $1 ORDER BY target_type, target_id;

-- name: ListWorkspaceRoomOverrides :many
SELECT rp.* FROM room_permissions rp
JOIN rooms r ON r.id = rp.room_id
WHERE r.workspace_id = $1 AND r.archived_at IS NULL
ORDER BY rp.room_id, rp.target_type, rp.target_id;

-- name: DeleteRoomOverrides :exec
DELETE FROM room_permissions WHERE room_id = $1;

-- name: InsertRoomOverride :exec
INSERT INTO room_permissions (room_id, target_type, target_id, allow, deny)
VALUES ($1, $2, $3, $4, $5);

-- name: GetRoomAccess :one
-- Everything needed to compute a user's permissions in a room, in one round trip.
SELECT r.workspace_id,
       m.role,
       ro.allow AS role_allow, ro.deny AS role_deny,
       uo.allow AS user_allow, uo.deny AS user_deny
FROM rooms r
JOIN workspace_members m ON m.workspace_id = r.workspace_id AND m.user_id = sqlc.arg('user_id')
LEFT JOIN room_permissions ro ON ro.room_id = r.id AND ro.target_type = 'role' AND ro.target_id = m.role
LEFT JOIN room_permissions uo ON uo.room_id = r.id AND uo.target_type = 'user' AND uo.target_id = sqlc.arg('user_id')::text
WHERE r.id = sqlc.arg('room_id') AND r.archived_at IS NULL;
