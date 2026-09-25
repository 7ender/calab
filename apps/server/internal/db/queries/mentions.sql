-- name: InsertMentions :exec
-- Direct mentions: only members of the room's workspace, never the author.
INSERT INTO message_mentions (user_id, message_id, room_id)
SELECT u, sqlc.arg('message_id')::uuid, sqlc.arg('room_id')::uuid
FROM unnest(sqlc.arg('user_ids')::uuid[]) AS u
JOIN workspace_members wm ON wm.user_id = u AND wm.workspace_id = sqlc.arg('workspace_id')::uuid
WHERE u <> sqlc.arg('author_id')::uuid
ON CONFLICT DO NOTHING;

-- name: InsertEveryoneMention :exec
INSERT INTO message_everyone_mentions (message_id, room_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: DeleteMentions :exec
DELETE FROM message_mentions WHERE message_id = $1;

-- name: DeleteEveryoneMention :exec
DELETE FROM message_everyone_mentions WHERE message_id = $1;

-- name: ListMentions :many
-- Newest first. Each branch is an index range scan limited to one page; own messages and
-- deleted ones are excluded (mention rows are removed on delete, the filter is a safety net).
WITH ids AS (
    (SELECT mm.message_id AS id FROM message_mentions mm
     WHERE mm.user_id = sqlc.arg('user_id')::uuid AND mm.room_id = ANY(sqlc.arg('room_ids')::uuid[])
       AND (sqlc.narg('before')::uuid IS NULL OR mm.message_id < sqlc.narg('before')::uuid)
     ORDER BY mm.message_id DESC LIMIT sqlc.arg('lim'))
    UNION
    (SELECT e.message_id FROM message_everyone_mentions e
     JOIN messages em ON em.id = e.message_id AND em.author_id <> sqlc.arg('user_id')::uuid
     WHERE e.room_id = ANY(sqlc.arg('room_ids')::uuid[])
       AND (sqlc.narg('before')::uuid IS NULL OR e.message_id < sqlc.narg('before')::uuid)
     ORDER BY e.message_id DESC LIMIT sqlc.arg('lim'))
)
SELECT m.* FROM messages m
JOIN ids ON ids.id = m.id
WHERE m.deleted_at IS NULL
ORDER BY m.id DESC
LIMIT sqlc.arg('lim');

-- name: UpsertRoomNotificationSettings :one
INSERT INTO room_notification_settings (user_id, room_id, level, muted_until)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, room_id) DO UPDATE SET level = EXCLUDED.level, muted_until = EXCLUDED.muted_until
RETURNING *;

-- name: DeleteRoomNotificationSettings :exec
DELETE FROM room_notification_settings WHERE user_id = $1 AND room_id = $2;

-- name: ListRoomNotificationSettings :many
-- Stored settings of live rooms in the user's workspaces.
SELECT s.* FROM room_notification_settings s
JOIN rooms r ON r.id = s.room_id AND r.archived_at IS NULL
JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = s.user_id
WHERE s.user_id = $1;
