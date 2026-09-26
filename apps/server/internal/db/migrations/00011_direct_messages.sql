-- Direct messages (ADR-0020): a DM is a room without a workspace, type 'dm', with exactly two
-- participants in dm_members. Messages, files, reactions, pins and read state reuse the room
-- tables. rooms is small (no rewrite: DROP NOT NULL and the new columns are metadata-only;
-- the CHECKs scan rooms once).

-- +goose Up
ALTER TABLE rooms ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text', 'dm'));
-- dm_key = least(a, b) || ':' || greatest(a, b) of the two participants: one DM per pair.
ALTER TABLE rooms ADD COLUMN dm_key text;
ALTER TABLE rooms ADD CONSTRAINT rooms_dm_scope CHECK ((type = 'dm') = (workspace_id IS NULL));
ALTER TABLE rooms ADD CONSTRAINT rooms_dm_key CHECK ((type = 'dm') = (dm_key IS NOT NULL));
CREATE UNIQUE INDEX rooms_dm_key_key ON rooms (dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE dm_members (
    room_id    uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX dm_members_user_id_idx ON dm_members (user_id);

-- Files of DMs are user-scoped (workspace_id NULL) like avatars; only avatars are public, so
-- the download check looks a file up by avatar (also speeds up the orphan cleanup's NOT EXISTS).
CREATE INDEX users_avatar_file_id_idx ON users (avatar_file_id) WHERE avatar_file_id IS NOT NULL;

-- +goose Down
DROP INDEX users_avatar_file_id_idx;
DROP TABLE dm_members;
DELETE FROM rooms WHERE type = 'dm';
DROP INDEX rooms_dm_key_key;
ALTER TABLE rooms DROP CONSTRAINT rooms_dm_key, DROP CONSTRAINT rooms_dm_scope, DROP COLUMN dm_key;
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text'));
ALTER TABLE rooms ALTER COLUMN workspace_id SET NOT NULL;
