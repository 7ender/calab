-- Message forwarding (ADR-0033): a copy is a new message of the target room with a link to the
-- original (always the first source: a copy of a copy points at the original) and the
-- original's author and time, kept so the «Переслано от» line survives the original's removal.
-- The index serves the recording card fan-out (System.Update) and RecordingVisibleInRoom.
-- A copy shows the same files as its source: an upload is still attached to at most one
-- message of its own (the unique index, now only over non-forwarded rows); forwarded rows add
-- rooms the file is readable in (FileRooms), so file_id gets a plain index again.

-- +goose Up
ALTER TABLE messages
    ADD COLUMN forwarded_from    uuid REFERENCES messages (id) ON DELETE SET NULL,
    ADD COLUMN forward_author_id uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN forward_sent_at   timestamptz;
CREATE INDEX messages_forwarded_from_idx ON messages (forwarded_from) WHERE forwarded_from IS NOT NULL;
ALTER TABLE message_attachments ADD COLUMN forwarded boolean NOT NULL DEFAULT false;
CREATE INDEX message_attachments_file_id_idx ON message_attachments (file_id);
DROP INDEX message_attachments_file_id_key;
CREATE UNIQUE INDEX message_attachments_file_id_key ON message_attachments (file_id) WHERE NOT forwarded;

-- +goose Down
DELETE FROM message_attachments WHERE forwarded;
DROP INDEX message_attachments_file_id_key;
CREATE UNIQUE INDEX message_attachments_file_id_key ON message_attachments (file_id);
DROP INDEX message_attachments_file_id_idx;
ALTER TABLE message_attachments DROP COLUMN forwarded;
DROP INDEX messages_forwarded_from_idx;
ALTER TABLE messages DROP COLUMN forward_sent_at, DROP COLUMN forward_author_id, DROP COLUMN forwarded_from;
