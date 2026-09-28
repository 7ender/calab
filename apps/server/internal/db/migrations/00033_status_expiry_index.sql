-- Temporary custom statuses (docs/09 #78, issue #17): the presence sweeper clears expired
-- ones every 15 s (ExpireCustomStatuses); the partial index keeps that tick off a full scan.

-- +goose Up
CREATE INDEX users_status_expires_idx ON users (status_expires_at) WHERE status_expires_at IS NOT NULL;

-- +goose Down
DROP INDEX users_status_expires_idx;
