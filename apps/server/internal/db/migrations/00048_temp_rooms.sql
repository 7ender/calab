-- Temporary rooms (ADR-0044).
--
-- rooms.expires_at  NULL = a permanent room; set = a temporary voice room archived by the
--                   sweeper at that time (archived_at).
-- rooms.created_by  who created the room (temporary rooms: the creator manages it without
--                   MANAGE_ROOM); NULL for older rooms and after the user is gone.
-- CREATE_TEMP_ROOMS (1 << 23 = 8388608): workspace-level, the built-in member role gets it (as
-- do new workspaces through workspace_builtin_roles); guests never. There is no built-in
-- moderator role; custom roles get it through the role editor.

-- +goose Up
ALTER TABLE rooms
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX rooms_expires_idx ON rooms (expires_at) WHERE expires_at IS NOT NULL AND archived_at IS NULL;
-- Retention of the archive (the hourly purge) and the archive listing.
CREATE INDEX rooms_temp_archived_idx ON rooms (workspace_id, archived_at) WHERE expires_at IS NOT NULL AND archived_at IS NOT NULL;
CREATE INDEX rooms_created_by_idx ON rooms (created_by) WHERE created_by IS NOT NULL;

UPDATE workspace_roles SET permissions = permissions | 8388608 WHERE builtin = 'member';

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 8798327, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 409719, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd
UPDATE workspace_roles SET permissions = permissions & ~8388608::bigint WHERE permissions & 8388608 <> 0;
UPDATE room_permissions SET allow = allow & ~8388608::bigint, deny = deny & ~8388608::bigint
WHERE (allow | deny) & 8388608 <> 0;
DROP INDEX rooms_created_by_idx;
DROP INDEX rooms_temp_archived_idx;
DROP INDEX rooms_expires_idx;
ALTER TABLE rooms DROP COLUMN created_by, DROP COLUMN expires_at;
