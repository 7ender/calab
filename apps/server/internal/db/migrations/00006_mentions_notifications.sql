-- Mentions history (GET /api/me/mentions) and per-room notification settings.
-- New tables only: no locks on existing large tables.

-- +goose Up
-- Direct mentions (@<user_id> in content), filled on create/edit. room_id is denormalized
-- so the history query filters by visible rooms without touching messages first.
CREATE TABLE message_mentions (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    room_id    uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX message_mentions_message_id_idx ON message_mentions (message_id);
CREATE INDEX message_mentions_room_id_idx ON message_mentions (room_id);

-- Messages with @everyone / @here: they mention every member who can view the room.
CREATE TABLE message_everyone_mentions (
    message_id uuid PRIMARY KEY REFERENCES messages (id) ON DELETE CASCADE,
    room_id    uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE
);
CREATE INDEX message_everyone_mentions_room_idx ON message_everyone_mentions (room_id, message_id DESC);

CREATE TABLE room_notification_settings (
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    room_id     uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    level       text NOT NULL CHECK (level IN ('all', 'mentions', 'none')),
    muted_until timestamptz,
    PRIMARY KEY (user_id, room_id)
);
CREATE INDEX room_notification_settings_room_id_idx ON room_notification_settings (room_id);

-- +goose Down
DROP TABLE room_notification_settings;
DROP TABLE message_everyone_mentions;
DROP TABLE message_mentions;
