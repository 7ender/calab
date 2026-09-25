-- UI backlog (docs/09): room categories, message search, reactions, custom status, pins.

-- +goose Up
CREATE TABLE room_categories (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_categories_workspace_id_idx ON room_categories (workspace_id, position);

ALTER TABLE rooms ADD COLUMN category_id uuid REFERENCES room_categories (id) ON DELETE SET NULL;

-- Full-text search: Russian stemming plus a 'simple' (no stemming) vector so that exact
-- words in any language, names and code identifiers are found too. An expression index
-- (not a stored generated column): no extra storage and `SELECT *` does not ship the vector.
-- Queries must use exactly this expression (see queries/messages.sql, SearchMessages).
CREATE INDEX messages_search_idx ON messages
    USING gin ((to_tsvector('russian', content) || to_tsvector('simple', content)));

ALTER TABLE messages
    ADD COLUMN pinned_at timestamptz,
    ADD COLUMN pinned_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX messages_pinned_idx ON messages (room_id, pinned_at DESC) WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE message_reactions (
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji      text NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 64),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, emoji, user_id)
);

ALTER TABLE users
    ADD COLUMN status_emoji text NOT NULL DEFAULT '' CHECK (octet_length(status_emoji) <= 64),
    ADD COLUMN status_expires_at timestamptz;

-- +goose Down
ALTER TABLE users DROP COLUMN status_expires_at, DROP COLUMN status_emoji;
DROP TABLE message_reactions;
DROP INDEX messages_pinned_idx;
ALTER TABLE messages DROP COLUMN pinned_by, DROP COLUMN pinned_at;
DROP INDEX messages_search_idx;
ALTER TABLE rooms DROP COLUMN category_id;
DROP TABLE room_categories;
