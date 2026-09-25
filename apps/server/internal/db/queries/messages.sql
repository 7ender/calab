-- name: InsertMessage :one
-- Idempotent by (author_id, nonce): no row = a message with this nonce already exists.
INSERT INTO messages (room_id, author_id, content, reply_to_id, nonce)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (author_id, nonce) WHERE nonce IS NOT NULL DO NOTHING
RETURNING *;

-- name: GetMessageByNonce :one
SELECT * FROM messages WHERE author_id = $1 AND nonce = $2;

-- name: GetMessage :one
SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL;

-- name: ListMessagesBefore :many
-- Newest first. NULL before = from the newest message.
SELECT * FROM messages
WHERE room_id = sqlc.arg('room_id') AND deleted_at IS NULL
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: ListMessagesAfter :many
-- Oldest first.
SELECT * FROM messages
WHERE room_id = sqlc.arg('room_id') AND deleted_at IS NULL AND id > sqlc.arg('after')::uuid
ORDER BY id ASC
LIMIT sqlc.arg('lim');

-- name: UpdateMessageContent :one
UPDATE messages SET content = $2, edited_at = now()
WHERE id = $1 AND deleted_at IS NULL
RETURNING *;

-- name: SoftDeleteMessage :execrows
UPDATE messages SET deleted_at = now(), content = ''
WHERE id = $1 AND deleted_at IS NULL;

-- name: DetachMessageFiles :exec
DELETE FROM message_attachments WHERE message_id = $1;

-- name: InsertAttachment :exec
INSERT INTO message_attachments (message_id, file_id, position) VALUES ($1, $2, $3);

-- name: ListAttachments :many
SELECT ma.message_id, sqlc.embed(f)
FROM message_attachments ma JOIN files f ON f.id = ma.file_id
WHERE ma.message_id = ANY(sqlc.arg('ids')::uuid[])
ORDER BY ma.message_id, ma.position;

-- name: UpsertReadState :one
-- The marker only moves forward (uuidv7 order = message order).
INSERT INTO read_states (user_id, room_id, last_read_message_id)
VALUES ($1, $2, $3)
ON CONFLICT (user_id, room_id) DO UPDATE
    SET last_read_message_id = GREATEST(read_states.last_read_message_id, EXCLUDED.last_read_message_id)
RETURNING *;

-- name: ListReadStates :many
SELECT rs.* FROM read_states rs
JOIN rooms r ON r.id = rs.room_id AND r.archived_at IS NULL
WHERE rs.user_id = $1;

-- name: LastMessages :many
-- Newest live message per room (uses messages_room_id_id_idx).
SELECT DISTINCT ON (room_id) room_id, id, created_at
FROM messages
WHERE room_id = ANY(sqlc.arg('room_ids')::uuid[]) AND deleted_at IS NULL
ORDER BY room_id, id DESC;

-- name: SearchMessages :many
-- Full-text search, newest first. The tsvector expression must match messages_search_idx.
SELECT * FROM messages
WHERE room_id = ANY(sqlc.arg('room_ids')::uuid[]) AND deleted_at IS NULL
  AND (to_tsvector('russian', content) || to_tsvector('simple', content))
      @@ (websearch_to_tsquery('russian', sqlc.arg('q')::text) || websearch_to_tsquery('simple', sqlc.arg('q')::text))
  AND (sqlc.narg('before')::uuid IS NULL OR id < sqlc.narg('before')::uuid)
  AND (sqlc.narg('author_id')::uuid IS NULL OR author_id = sqlc.narg('author_id')::uuid)
ORDER BY id DESC
LIMIT sqlc.arg('lim');

-- name: AddReaction :execrows
INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING;

-- name: RemoveReaction :execrows
DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3;

-- name: ReactionEmojiStats :one
-- Distinct emojis on a message and whether this emoji is among them (for the per-message cap).
SELECT count(DISTINCT emoji)::integer AS distinct_emojis,
       coalesce(bool_or(emoji = sqlc.arg('emoji')), false)::boolean AS has_emoji
FROM message_reactions WHERE message_id = sqlc.arg('message_id');

-- name: ListReactions :many
-- Aggregates per message and emoji, in order of first use; me = the viewer reacted.
SELECT message_id, emoji, count(*)::integer AS count,
       bool_or(user_id = sqlc.arg('viewer'))::boolean AS me, min(created_at)::timestamptz AS first_at
FROM message_reactions
WHERE message_id = ANY(sqlc.arg('ids')::uuid[])
GROUP BY message_id, emoji
ORDER BY message_id, first_at;

-- name: PinMessage :one
UPDATE messages SET pinned_at = now(), pinned_by = sqlc.arg('pinned_by')
WHERE id = sqlc.arg('id') AND deleted_at IS NULL AND pinned_at IS NULL
RETURNING *;

-- name: UnpinMessage :one
UPDATE messages SET pinned_at = NULL, pinned_by = NULL
WHERE id = $1 AND deleted_at IS NULL AND pinned_at IS NOT NULL
RETURNING *;

-- name: CountPins :one
SELECT count(*)::integer FROM messages WHERE room_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL;

-- name: ListPins :many
SELECT * FROM messages
WHERE room_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
ORDER BY pinned_at DESC
LIMIT 50;
