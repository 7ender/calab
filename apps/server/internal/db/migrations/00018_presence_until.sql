-- Manual status shared by all devices of a user (docs/05 «Presence»): IDLE / DND / INVISIBLE
-- (PresenceStatus value) until presence_until (NULL = no end). Valkey holds the live copy
-- (presence:manual:<user_id>, expiring at presence_until); this row restores it after a
-- Valkey restart and lets the sweeper find statuses that ran out.

-- +goose Up
ALTER TABLE users
    ADD COLUMN presence_status smallint CHECK (presence_status IN (2, 3, 4)),
    ADD COLUMN presence_until timestamptz,
    ADD CONSTRAINT users_presence_until_check CHECK (presence_until IS NULL OR presence_status IS NOT NULL);
CREATE INDEX users_presence_idx ON users (presence_until) WHERE presence_status IS NOT NULL;

-- +goose Down
DROP INDEX users_presence_idx;
ALTER TABLE users DROP CONSTRAINT users_presence_until_check, DROP COLUMN presence_until, DROP COLUMN presence_status;
