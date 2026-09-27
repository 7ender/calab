-- DM archive and «delete for me» (docs/09 item 51, ADR-0020): each participant's own state of a
-- DM. archived_at set = the DM is in the participant's archive (an incoming message clears it);
-- cleared_before = «Удалить чат»: the participant no longer sees messages with id <= it (history,
-- search, pins, the list preview and unread counts start after it). The peer is not affected.
-- No row = neither. The FK keeps the state to the DM's two participants.

-- +goose Up
CREATE TABLE dm_state (
    user_id        uuid NOT NULL,
    room_id        uuid NOT NULL,
    archived_at    timestamptz,
    cleared_before uuid,
    PRIMARY KEY (user_id, room_id),
    FOREIGN KEY (room_id, user_id) REFERENCES dm_members (room_id, user_id) ON DELETE CASCADE
);
-- Un-archiving on an incoming message looks the DM's archived rows up by room.
CREATE INDEX dm_state_archived_room_id_idx ON dm_state (room_id) WHERE archived_at IS NOT NULL;

-- +goose Down
DROP TABLE dm_state;
