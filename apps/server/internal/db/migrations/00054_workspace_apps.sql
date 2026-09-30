-- Web apps of a workspace (ADR-0050): sites pinned to the rail under the workspace icon.
--
-- name 1..40; url ≤ 2048 (https://, or http:// to a private host — checked by the server);
-- icon_file_id: an image of the workspace (readable by its members, files.CanRead), NULL = the
-- first letter of the name; position: fractional order in the rail. ≤ 20 per workspace (checked
-- by the server under an advisory lock).

-- +goose Up
CREATE TABLE workspace_apps (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    url          text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
    icon_file_id uuid REFERENCES files (id) ON DELETE SET NULL,
    position     double precision NOT NULL DEFAULT 0,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_apps_workspace_idx ON workspace_apps (workspace_id, position, id);
CREATE INDEX workspace_apps_icon_idx ON workspace_apps (icon_file_id) WHERE icon_file_id IS NOT NULL;

-- +goose Down
DROP TABLE workspace_apps;
