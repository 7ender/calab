-- Retry of a failed recording (docs/09 backlog 40): «Отправить снова» sends the local file to
-- GPTunneL again as a new recording there.
--
-- reuploads:   how many times it was sent again; GPTunneL's create is idempotent on client_id,
--              so a re-upload uses "<id>#<reuploads>" to get a new recording.
-- reupload_at: when it was last sent again: the 24 h upload window and the 7-day file
--              retention count from it instead of stopped_at.

-- +goose Up
ALTER TABLE room_recordings
    ADD COLUMN reuploads integer NOT NULL DEFAULT 0,
    ADD COLUMN reupload_at timestamptz;

-- +goose Down
ALTER TABLE room_recordings DROP COLUMN reupload_at, DROP COLUMN reuploads;
