-- Camera backgrounds of a workspace (ADR-0035, addendum 2026-09-29): pictures an admin adds for
-- everyone's camera preview, at most 20 per workspace (enforced by the API). The file is the
-- server-made 1280×720 WebP; deleting the row leaves it to the orphan cleanup (which skips live
-- background files).

-- +goose Up
CREATE TABLE workspace_backgrounds (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    file_id      uuid NOT NULL REFERENCES files (id),
    position     smallint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_backgrounds_workspace_idx ON workspace_backgrounds (workspace_id, position, id);
CREATE INDEX workspace_backgrounds_file_idx ON workspace_backgrounds (file_id);

-- +goose Down
DROP TABLE workspace_backgrounds;
