-- Soundboard of a workspace (ADR-0036): short clips a participant of a voice call plays to the
-- whole call, at most 50 per workspace (enforced by the API). The file is the server-made
-- Ogg/Opus clip; deleting the row leaves it to the orphan cleanup (which skips live sound files).

-- +goose Up
CREATE TABLE workspace_sounds (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
    emoji        text NOT NULL DEFAULT '' CHECK (octet_length(emoji) <= 64),
    file_id      uuid NOT NULL REFERENCES files (id),
    duration_ms  integer NOT NULL CHECK (duration_ms BETWEEN 1 AND 5000),
    position     smallint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_sounds_workspace_idx ON workspace_sounds (workspace_id, position, id);
CREATE INDEX workspace_sounds_file_idx ON workspace_sounds (file_id);

-- +goose Down
DROP TABLE workspace_sounds;
