-- Bot inline keyboards and stable callback receipts (ADR-0047).
-- +goose Up
ALTER TABLE messages ADD COLUMN inline_keyboard jsonb;
ALTER TABLE messages ADD COLUMN keyboard_revision bigint NOT NULL DEFAULT 0 CHECK (keyboard_revision >= 0);
CREATE TABLE message_interactions (
    id uuid PRIMARY KEY DEFAULT uuidv7(),
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    nonce text NOT NULL CHECK (octet_length(nonce) BETWEEN 1 AND 64),
    button_id text NOT NULL,
    keyboard_revision bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, nonce)
);
CREATE INDEX message_interactions_message_idx ON message_interactions (message_id);

-- +goose Down
DROP TABLE message_interactions;
ALTER TABLE messages DROP COLUMN inline_keyboard, DROP COLUMN keyboard_revision;
