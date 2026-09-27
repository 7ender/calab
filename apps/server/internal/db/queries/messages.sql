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
-- One row per given (visible) room: the read marker (NULL if the user never read the
-- room) and the unread / mention counts after it, both capped at 999. Without a marker
-- the counts start at the user's joining of the workspace (a uuidv7 lower bound from
-- joined_at). Every count is a bounded index-only range scan: messages_live_room_id_idx
-- (room_id, id) INCLUDE (author_id) WHERE deleted_at IS NULL and
-- message_mentions_user_room_idx (user_id, room_id, message_id) — migration 00007.
SELECT b.room_id::uuid AS room_id,
    b.marker AS last_read_message_id,
    (SELECT count(*) FROM (
        SELECT 1 FROM messages m
        WHERE m.room_id = b.room_id AND m.id > b.after
          AND m.deleted_at IS NULL AND m.author_id <> sqlc.arg('user_id')::uuid
        LIMIT 999) u)::integer AS unread_count,
    (SELECT count(*) FROM (
        SELECT mm.message_id FROM message_mentions mm
        WHERE mm.user_id = sqlc.arg('user_id')::uuid AND mm.room_id = b.room_id AND mm.message_id > b.after
        UNION
        SELECT e.message_id FROM message_everyone_mentions e
        JOIN messages em ON em.id = e.message_id AND em.author_id <> sqlc.arg('user_id')::uuid
        WHERE e.room_id = b.room_id AND e.message_id > b.after
        LIMIT 999) x)::integer AS mention_count
FROM (
    SELECT v.room_id, rs.last_read_message_id AS marker,
        coalesce(rs.last_read_message_id, (
            substr(lpad(to_hex((extract(epoch FROM wm.joined_at) * 1000)::bigint), 12, '0'), 1, 8) || '-' ||
            substr(lpad(to_hex((extract(epoch FROM wm.joined_at) * 1000)::bigint), 12, '0'), 9, 4) ||
            '-0000-0000-000000000000')::uuid) AS after
    FROM unnest(sqlc.arg('room_ids')::uuid[]) AS v (room_id)
    JOIN rooms r ON r.id = v.room_id
    JOIN workspace_members wm ON wm.workspace_id = r.workspace_id AND wm.user_id = sqlc.arg('user_id')::uuid
    LEFT JOIN read_states rs ON rs.user_id = sqlc.arg('user_id')::uuid AND rs.room_id = v.room_id
) b;

-- name: LastMessages :many
-- Newest live message per room: one backwards index probe per room (LATERAL … LIMIT 1),
-- independent of history size.
SELECT r.id::uuid AS room_id, lm.id, lm.created_at
FROM unnest(sqlc.arg('room_ids')::uuid[]) AS r(id)
CROSS JOIN LATERAL (
    SELECT m.id, m.created_at FROM messages m
    WHERE m.room_id = r.id AND m.deleted_at IS NULL
    ORDER BY m.id DESC
    LIMIT 1
) lm;

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

-- name: LockMessageReactions :exec
-- Serializes reaction writes on one message (inside a transaction) so the per-message and
-- per-user caps cannot be exceeded by concurrent requests. NO KEY UPDATE does not block
-- foreign-key checks of other transactions.
SELECT id FROM messages WHERE id = $1 FOR NO KEY UPDATE;

-- name: ReactionEmojiStats :one
-- Distinct emojis on a message and whether this emoji is among them (per-message cap), plus
-- the same for the given user (per-user cap, MaxReactionsPerUser).
SELECT count(DISTINCT emoji)::integer AS distinct_emojis,
       coalesce(bool_or(emoji = sqlc.arg('emoji')), false)::boolean AS has_emoji,
       count(*) FILTER (WHERE user_id = sqlc.arg('user_id'))::integer AS user_emojis,
       coalesce(bool_or(emoji = sqlc.arg('emoji') AND user_id = sqlc.arg('user_id')), false)::boolean AS user_has_emoji
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

-- name: SetEmbedsHidden :one
UPDATE messages SET embeds_hidden = $2 WHERE id = $1 AND deleted_at IS NULL
RETURNING *;
