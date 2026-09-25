-- Code review M9: indexes for ON DELETE referential actions (workspace/user deletion was
-- O(n²) through sequential scans of messages per deleted row).

-- +goose Up
CREATE INDEX messages_reply_to_id_idx ON messages (reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX messages_pinned_by_idx ON messages (pinned_by) WHERE pinned_by IS NOT NULL;
CREATE INDEX message_reactions_user_id_idx ON message_reactions (user_id);
CREATE INDEX files_unattached_uploader_idx ON files (uploader_id, created_at);

-- +goose Down
DROP INDEX files_unattached_uploader_idx;
DROP INDEX message_reactions_user_id_idx;
DROP INDEX messages_pinned_by_idx;
DROP INDEX messages_reply_to_id_idx;
