-- Stage 3: user-scoped files (avatars) and indexes for messages/files.

-- +goose Up
-- NULL workspace_id = user-scoped file (avatar); does not count toward any workspace quota.
ALTER TABLE files ALTER COLUMN workspace_id DROP NOT NULL;
CREATE INDEX files_created_at_idx ON files (created_at);
CREATE INDEX files_uploader_id_idx ON files (uploader_id);
CREATE INDEX read_states_room_id_idx ON read_states (room_id);
-- A file is attached to at most one message (access to it follows that message's room).
DROP INDEX message_attachments_file_id_idx;
CREATE UNIQUE INDEX message_attachments_file_id_key ON message_attachments (file_id);

-- +goose Down
DROP INDEX message_attachments_file_id_key;
CREATE INDEX message_attachments_file_id_idx ON message_attachments (file_id);
DROP INDEX read_states_room_id_idx;
DROP INDEX files_uploader_id_idx;
DROP INDEX files_created_at_idx;
DELETE FROM files WHERE workspace_id IS NULL;
ALTER TABLE files ALTER COLUMN workspace_id SET NOT NULL;
