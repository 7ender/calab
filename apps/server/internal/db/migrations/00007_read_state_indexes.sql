-- +goose NO TRANSACTION
-- Review 4 M2: READY counts unread messages and mentions per visible room. These indexes make
-- both counts bounded index-only scans (the unread one no longer visits heap rows for
-- deleted_at / author_id; the mention one no longer ANDs the per-room index of all users).
-- CONCURRENTLY: messages may be large (review R9). message_mentions_room_id_idx stays for
-- the ON DELETE CASCADE of rooms.

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_live_room_id_idx ON messages (room_id, id) INCLUDE (author_id) WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_mentions_user_room_idx ON message_mentions (user_id, room_id, message_id);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS message_mentions_user_room_idx;
DROP INDEX CONCURRENTLY IF EXISTS messages_live_room_id_idx;
