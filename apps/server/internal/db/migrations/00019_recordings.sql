-- Meeting recording and GPTunneL transcription (ADR-0025).
--
-- rooms.allow_recording: the workspace owner / admins may forbid recording a room.
-- messages.kind / payload: system messages (kind 'system', payload = protojson of
--   calaba.v1.SystemMessage, e.g. the recording card). Their author is the user the event is
--   about (who started the recording); they cannot be edited.
-- workspace_integrations: the GPTunneL device token of a workspace, sealed with a key derived
--   from JWT_SECRET (AES-GCM, like mail_outbox.params). token_enc is NULL once unpaired.
-- room_recordings: every recording and its whole life (status), also the upload / status
--   poll queue (next_at, attempts; a claimed row is leased by moving next_at ahead).

-- +goose Up
ALTER TABLE rooms ADD COLUMN allow_recording boolean NOT NULL DEFAULT true;

ALTER TABLE messages
    ADD COLUMN kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
    ADD COLUMN payload jsonb CHECK (payload IS NULL OR jsonb_typeof(payload) = 'object');

CREATE TABLE workspace_integrations (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('gptunnel')),
    token_enc    bytea,
    device_id    text NOT NULL DEFAULT '' CHECK (char_length(device_id) <= 200),
    device_name  text NOT NULL DEFAULT '' CHECK (char_length(device_name) <= 200),
    account      text NOT NULL DEFAULT '' CHECK (char_length(account) <= 320),
    web_url      text NOT NULL DEFAULT '' CHECK (char_length(web_url) <= 2000),
    paired_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    paired_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    PRIMARY KEY (workspace_id, kind)
);
CREATE INDEX workspace_integrations_paired_by_idx ON workspace_integrations (paired_by) WHERE paired_by IS NOT NULL;

CREATE TABLE room_recordings (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    room_id          uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    started_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    stopped_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'recording', 'uploading', 'processing', 'done', 'failed')),
    -- why it stopped: user | empty | max_duration | disabled | egress | lost
    stop_reason      text NOT NULL DEFAULT '',
    egress_id        text,
    file             text NOT NULL DEFAULT '',   -- relative to RECORDINGS_PATH: <workspace>/<id>.mp4
    size_bytes       bigint NOT NULL DEFAULT 0,
    duration_sec     integer NOT NULL DEFAULT 0,
    started_at       timestamptz NOT NULL DEFAULT now(),
    stopped_at       timestamptz,
    empty_since      timestamptz,                -- nobody in the call since (auto-stop after 2 min)
    gptunnel_id      text NOT NULL DEFAULT '',
    web_url          text NOT NULL DEFAULT '' CHECK (char_length(web_url) <= 2000),
    error            text NOT NULL DEFAULT '' CHECK (char_length(error) <= 500),
    message_id       uuid REFERENCES messages (id) ON DELETE SET NULL,
    attempts         integer NOT NULL DEFAULT 0,
    next_at          timestamptz,                -- upload / poll due; NULL = nothing to do
    processing_since timestamptz,                -- upload completed: the status poll runs ≤ 2 h from here
    file_deleted_at  timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now()
);
-- One running recording per room.
CREATE UNIQUE INDEX room_recordings_active_key ON room_recordings (room_id) WHERE status IN ('pending', 'recording');
CREATE UNIQUE INDEX room_recordings_egress_key ON room_recordings (egress_id) WHERE egress_id IS NOT NULL;
CREATE INDEX room_recordings_room_id_idx ON room_recordings (room_id, id DESC);
CREATE INDEX room_recordings_workspace_id_idx ON room_recordings (workspace_id, id DESC);
CREATE INDEX room_recordings_due_idx ON room_recordings (next_at) WHERE next_at IS NOT NULL;
CREATE INDEX room_recordings_files_idx ON room_recordings (stopped_at) WHERE file <> '' AND file_deleted_at IS NULL;
-- ON DELETE SET NULL from users / messages needs its own index.
CREATE INDEX room_recordings_started_by_idx ON room_recordings (started_by) WHERE started_by IS NOT NULL;
CREATE INDEX room_recordings_stopped_by_idx ON room_recordings (stopped_by) WHERE stopped_by IS NOT NULL;
CREATE INDEX room_recordings_message_id_idx ON room_recordings (message_id) WHERE message_id IS NOT NULL;

-- +goose Down
DROP TABLE room_recordings;
DROP TABLE workspace_integrations;
ALTER TABLE messages DROP COLUMN payload, DROP COLUMN kind;
ALTER TABLE rooms DROP COLUMN allow_recording;
