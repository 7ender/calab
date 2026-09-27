-- Restricted private rooms (ADR-0029, docs/09 #46): ADMINISTRATOR gives no bypass in them,
-- only the workspace owner always has access. Set only on private rooms.

-- +goose Up
ALTER TABLE rooms
    ADD COLUMN restricted boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT rooms_restricted_private CHECK (NOT restricted OR is_private);

-- +goose Down
ALTER TABLE rooms DROP CONSTRAINT rooms_restricted_private, DROP COLUMN restricted;
