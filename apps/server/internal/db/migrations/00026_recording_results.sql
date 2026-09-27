-- Meeting transcription v2 (docs/09 #47, #50, docs/17): after GPTunneL reports done, the
-- server keeps the recording's audio as an attachment of the chat card (RECORDING_KEEP_DAYS)
-- and copies the summary and the transcript from GPTunneL's device API.
--
-- done_at:         when GPTunneL reported done (the audio is kept RECORDING_KEEP_DAYS from it).
-- summary:         GPTunneL's Markdown summary ('' = none).
-- language:        the transcript's language ('' = unknown).
-- transcript_json: GPTunneL's segments [{speaker, start, end, text}] as received; NULL = none.
-- result_state:    '' (not done), pending (audio / result still to fetch), ready, unavailable
--                  (GPTunneL did not give the result within the retry window).
-- result_attempts, result_next_at: the fetch's backoff.
-- file_id:         the audio attachment (files row) of the card; NULL once expired or deleted.
-- deleted_at/_by:  the recording was deleted from its card (#50): the row stays for the card.

-- +goose Up
ALTER TABLE room_recordings
    ADD COLUMN done_at         timestamptz,
    ADD COLUMN summary         text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 50000),
    ADD COLUMN language        text NOT NULL DEFAULT '' CHECK (char_length(language) <= 16),
    ADD COLUMN transcript_json jsonb,
    ADD COLUMN result_state    text NOT NULL DEFAULT '' CHECK (result_state IN ('', 'pending', 'ready', 'unavailable')),
    ADD COLUMN result_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN result_next_at  timestamptz,
    ADD COLUMN file_id         uuid REFERENCES files (id) ON DELETE SET NULL,
    ADD COLUMN deleted_at      timestamptz,
    ADD COLUMN deleted_by      uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX room_recordings_result_due_idx ON room_recordings (result_next_at) WHERE result_state = 'pending';
CREATE INDEX room_recordings_file_id_idx ON room_recordings (file_id) WHERE file_id IS NOT NULL;

-- +goose Down
DROP INDEX room_recordings_file_id_idx;
DROP INDEX room_recordings_result_due_idx;
ALTER TABLE room_recordings
    DROP COLUMN deleted_by, DROP COLUMN deleted_at, DROP COLUMN file_id, DROP COLUMN result_next_at,
    DROP COLUMN result_attempts, DROP COLUMN result_state, DROP COLUMN transcript_json,
    DROP COLUMN language, DROP COLUMN summary, DROP COLUMN done_at;
