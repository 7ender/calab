-- Invitation permissions (ADR-0043): INVITE_MEMBERS (1 << 21 = 2097152) and INVITE_GUESTS
-- (1 << 22 = 4194304), no longer implied by MANAGE_WORKSPACE / MANAGE_ROOM. Nobody loses a
-- capability on upgrade:
-- - every role with MANAGE_WORKSPACE (512) gets INVITE_MEMBERS, every role with MANAGE_ROOM
--   (256) gets INVITE_GUESTS (built-in owner / admin hold ADMINISTRATOR = everything anyway);
-- - a room override that allows / denies MANAGE_ROOM allows / denies INVITE_GUESTS too (room
--   moderators keep their guest links; a room that denied MANAGE_ROOM stays closed to them).
-- room_invites.members_only: a link only for members of the workspace (not guests); made with
-- INVITE_MEMBERS in the room.

-- +goose Up
UPDATE workspace_roles SET permissions = permissions | 2097152 WHERE permissions & 512 <> 0;
UPDATE workspace_roles SET permissions = permissions | 4194304 WHERE permissions & 256 <> 0;
UPDATE room_permissions SET allow = allow | 4194304 WHERE allow & 256 <> 0;
UPDATE room_permissions SET deny = deny | 4194304 WHERE deny & 256 <> 0;
ALTER TABLE room_invites ADD COLUMN members_only boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE room_invites DROP COLUMN members_only;
UPDATE room_permissions SET allow = allow & ~6291456::bigint, deny = deny & ~6291456::bigint
WHERE (allow | deny) & 6291456 <> 0;
UPDATE workspace_roles SET permissions = permissions & ~6291456::bigint WHERE permissions & 6291456 <> 0;
