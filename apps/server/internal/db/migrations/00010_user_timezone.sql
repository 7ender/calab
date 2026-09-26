-- User's IANA time zone (docs/09: "(+3 UTC)" next to members). NULL = not set.
-- Metadata-only column addition.

-- +goose Up
ALTER TABLE users ADD COLUMN timezone text CHECK (char_length(timezone) BETWEEN 1 AND 64);

-- +goose Down
ALTER TABLE users DROP COLUMN timezone;
