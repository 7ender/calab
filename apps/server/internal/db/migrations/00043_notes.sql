-- Notes shelves (ADR-0039): a shelf is a room without a workspace, type 'notes', whose owner is
-- its only row in dm_members — every DM code path (access, events on user channels, files,
-- pins, read state, forwarding) serves it unchanged. rooms.emoji is the shelf's emoji ('' =
-- none; other rooms keep ''). users.storage_quota_bytes: the personal file quota of shelves
-- (NULL = the server default DEFAULT_PERSONAL_QUOTA_BYTES). ADD COLUMN with a constant default
-- / NULL is metadata-only; the CHECKs scan rooms once (small).

-- +goose Up
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text', 'dm', 'notes'));
ALTER TABLE rooms DROP CONSTRAINT rooms_dm_scope;
ALTER TABLE rooms ADD CONSTRAINT rooms_dm_scope CHECK ((type IN ('dm', 'notes')) = (workspace_id IS NULL));
ALTER TABLE rooms ADD COLUMN emoji text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN storage_quota_bytes bigint CHECK (storage_quota_bytes >= 0);

-- +goose Down
ALTER TABLE users DROP COLUMN storage_quota_bytes;
DELETE FROM rooms WHERE type = 'notes';
ALTER TABLE rooms DROP COLUMN emoji;
ALTER TABLE rooms DROP CONSTRAINT rooms_dm_scope;
ALTER TABLE rooms ADD CONSTRAINT rooms_dm_scope CHECK ((type = 'dm') = (workspace_id IS NULL));
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text', 'dm'));
