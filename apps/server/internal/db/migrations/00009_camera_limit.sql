-- v0.2 webcams (docs/09 #41-45): how many cameras a voice room allows at once.
-- Workspace default 6; a room override NULL = use the default; 0 = cameras off.
-- Metadata-only column additions (constant default): no table rewrite.

-- +goose Up
ALTER TABLE workspaces ADD COLUMN default_camera_limit integer NOT NULL DEFAULT 6
    CHECK (default_camera_limit BETWEEN 0 AND 25);
ALTER TABLE rooms ADD COLUMN camera_limit integer CHECK (camera_limit BETWEEN 0 AND 25);

-- +goose Down
ALTER TABLE rooms DROP COLUMN camera_limit;
ALTER TABLE workspaces DROP COLUMN default_camera_limit;
