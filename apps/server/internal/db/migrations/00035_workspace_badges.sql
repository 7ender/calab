-- Member badges (docs/09 #82): a workspace library of small square pictures (e.g. partners'
-- logos, at most 20 per workspace, enforced by the API) and one badge per member, set by an
-- admin. Deleting a badge clears it from its members; deleting the picture's file is prevented
-- while a badge uses it (the orphan cleanup skips badge files).

-- +goose Up
CREATE TABLE workspace_badges (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
    file_id      uuid NOT NULL REFERENCES files (id),
    position     smallint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_badges_workspace_idx ON workspace_badges (workspace_id, position, id);
CREATE INDEX workspace_badges_file_idx ON workspace_badges (file_id);

ALTER TABLE workspace_members
    ADD COLUMN badge_id uuid REFERENCES workspace_badges (id) ON DELETE SET NULL;
CREATE INDEX workspace_members_badge_idx ON workspace_members (badge_id) WHERE badge_id IS NOT NULL;

-- +goose Down
ALTER TABLE workspace_members DROP COLUMN badge_id;
DROP TABLE workspace_badges;
