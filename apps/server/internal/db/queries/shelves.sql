-- Notes shelves (ADR-0039). A shelf is a room with type 'notes', no workspace and exactly one
-- row in dm_members: its owner. (user_notes in notes.sql are private notes about people.)

-- name: LockNotes :exec
-- Serializes a user's shelf creations (the per-user cap) and reorders.
SELECT pg_advisory_xact_lock(hashtext('calaba.notes:' || sqlc.arg('user_id')::uuid::text));

-- name: CountNotes :one
SELECT count(*)::integer FROM dm_members d
JOIN rooms r ON r.id = d.room_id AND r.type = 'notes' AND r.archived_at IS NULL
WHERE d.user_id = $1;

-- name: CreateNotesRoom :one
-- A new shelf goes last among the user's shelves.
INSERT INTO rooms (workspace_id, type, name, emoji, position)
VALUES (NULL, 'notes', sqlc.arg('name'), sqlc.arg('emoji'),
        (SELECT coalesce(max(r.position) + 1, 0) FROM dm_members d
         JOIN rooms r ON r.id = d.room_id AND r.type = 'notes'
         WHERE d.user_id = sqlc.arg('user_id')))
RETURNING *;

-- name: GetNotesRoom :one
-- The user's shelf (no row = not theirs, not a shelf, or gone).
SELECT r.* FROM rooms r
JOIN dm_members d ON d.room_id = r.id AND d.user_id = sqlc.arg('user_id')
WHERE r.id = sqlc.arg('room_id') AND r.type = 'notes' AND r.archived_at IS NULL;

-- name: UpdateNotesRoom :one
UPDATE rooms SET
    name     = coalesce(sqlc.narg('name'), name),
    emoji    = coalesce(sqlc.narg('emoji'), emoji),
    position = coalesce(sqlc.narg('position'), position)
WHERE id = sqlc.arg('id') AND type = 'notes'
RETURNING *;

-- name: DeleteNotesRoom :execrows
-- Messages, reactions, pins, read state and membership go by cascade; the shelf's own uploads
-- become orphans for the file cleanup.
DELETE FROM rooms WHERE id = $1 AND type = 'notes';

-- name: ListNotes :many
-- The user's shelves by position with the newest live message as the list preview (as
-- ListDMs: author, first 200 characters, attachment and sticker). room_id NULL = all.
SELECT sqlc.embed(r),
       (lm.id IS NOT NULL)::boolean AS has_messages,
       coalesce(lm.id, r.id)::uuid AS last_message_id,
       coalesce(lm.created_at, r.created_at)::timestamptz AS last_message_at,
       coalesce(lm.author_id, d.user_id)::uuid AS last_author_id,
       coalesce(lm.preview, '')::text AS last_preview,
       coalesce(lm.attachments, 0)::integer AS last_attachments,
       coalesce(lm.sticker_emoji, '')::text AS last_sticker_emoji
FROM dm_members d
JOIN rooms r ON r.id = d.room_id AND r.type = 'notes' AND r.archived_at IS NULL
LEFT JOIN LATERAL (
    SELECT m.id, m.created_at, m.author_id, left(m.content, 200) AS preview,
           (SELECT count(*) FROM message_attachments ma WHERE ma.message_id = m.id) AS attachments,
           (SELECT st.emoji FROM stickers st WHERE st.id = m.sticker_id) AS sticker_emoji
    FROM messages m
    WHERE m.room_id = r.id AND m.deleted_at IS NULL
    ORDER BY m.id DESC
    LIMIT 1
) lm ON true
WHERE d.user_id = sqlc.arg('user_id')
  AND (sqlc.narg('room_id')::uuid IS NULL OR r.id = sqlc.narg('room_id')::uuid)
ORDER BY r.position, r.id;

-- name: PersonalStorageBytes :one
-- The user's personal quota usage (ADR-0039 §5): their user-scoped uploads (no workspace, not
-- the avatar) that are not attached yet or are attached to a live message of a shelf.
SELECT coalesce(sum(f.size), 0)::bigint FROM files f
WHERE f.uploader_id = $1 AND f.workspace_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
  AND (NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.file_id = f.id)
       OR EXISTS (SELECT 1 FROM message_attachments ma
                  JOIN messages m ON m.id = ma.message_id AND m.deleted_at IS NULL
                  JOIN rooms r ON r.id = m.room_id AND r.type = 'notes'
                  WHERE ma.file_id = f.id));

-- name: SetUserStorageQuota :one
-- Superadmin: the user's personal quota (NULL = the server default).
UPDATE users SET storage_quota_bytes = sqlc.narg('quota') WHERE id = sqlc.arg('id')
RETURNING storage_quota_bytes;
