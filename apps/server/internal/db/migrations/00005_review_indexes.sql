-- +goose NO TRANSACTION
-- Code review M9: indexes for ON DELETE referential actions (workspace/user deletion was
-- O(n²) through sequential scans of messages per deleted row). Built CONCURRENTLY so that
-- writes to messages are not blocked on a large table (review R9); IF NOT EXISTS makes a
-- re-run after an interrupted concurrent build safe (drop an INVALID index first).

-- +goose Up
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_reply_to_id_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_pinned_by_idx ON messages (pinned_by) WHERE pinned_by IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_reactions_user_id_idx ON message_reactions (user_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS files_unattached_uploader_idx ON files (uploader_id, created_at);

-- +goose Down
DROP INDEX CONCURRENTLY IF EXISTS files_unattached_uploader_idx;
DROP INDEX CONCURRENTLY IF EXISTS message_reactions_user_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS messages_pinned_by_idx;
DROP INDEX CONCURRENTLY IF EXISTS messages_reply_to_id_idx;
