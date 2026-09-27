-- Sticker packs (ADR-0030). "Live" = deleted_at IS NULL; soft-deleted packs / stickers only
-- stay for the messages that show them.

-- name: LockWorkspaceStickers :exec
-- Serializes pack / sticker creation of one workspace between the plan-limit count and the insert.
SELECT pg_advisory_xact_lock(hashtext('calaba.stickers.' || sqlc.arg('workspace_id')::uuid::text));

-- name: ListWorkspaceStickerPacks :many
SELECT * FROM sticker_packs WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY id;

-- name: GetStickerPack :one
SELECT * FROM sticker_packs WHERE id = $1 AND deleted_at IS NULL;

-- name: CountWorkspaceStickerPacks :one
SELECT count(*)::integer FROM sticker_packs WHERE workspace_id = $1 AND deleted_at IS NULL;

-- name: CountWorkspaceStickers :one
SELECT count(*)::integer FROM stickers s
JOIN sticker_packs p ON p.id = s.pack_id AND p.deleted_at IS NULL
WHERE p.workspace_id = $1 AND s.deleted_at IS NULL;

-- name: CountPackStickers :one
SELECT count(*)::integer FROM stickers WHERE pack_id = $1 AND deleted_at IS NULL;

-- name: InsertStickerPack :one
-- No row = the short name is taken in the workspace.
INSERT INTO sticker_packs (workspace_id, name, short_name, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (workspace_id, short_name) WHERE deleted_at IS NULL DO NOTHING
RETURNING *;

-- name: UpdateStickerPack :one
UPDATE sticker_packs SET
    name = coalesce(sqlc.narg('name'), name),
    short_name = coalesce(sqlc.narg('short_name'), short_name),
    cover_sticker_id = CASE WHEN sqlc.arg('set_cover')::boolean THEN sqlc.narg('cover_sticker_id')::uuid ELSE cover_sticker_id END,
    updated_at = now()
WHERE id = sqlc.arg('id') AND deleted_at IS NULL
RETURNING *;

-- name: TouchStickerPack :exec
UPDATE sticker_packs SET updated_at = now() WHERE id = $1;

-- name: SoftDeleteStickerPack :execrows
UPDATE sticker_packs SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL;

-- name: DeleteUnreferencedPackStickers :exec
-- Stickers of the pack that no message shows are removed; their files become orphans.
DELETE FROM stickers s WHERE s.pack_id = $1
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sticker_id = s.id);

-- name: SoftDeletePackStickers :exec
UPDATE stickers SET deleted_at = now() WHERE pack_id = $1 AND deleted_at IS NULL;

-- name: DeleteStickerPackIfEmpty :exec
-- A deleted pack without stickers left (none shown by messages) goes for good.
DELETE FROM sticker_packs p WHERE p.id = $1 AND p.deleted_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM stickers s WHERE s.pack_id = p.id);

-- name: UninstallStickerPackForAll :exec
DELETE FROM user_sticker_packs WHERE pack_id = $1;

-- name: NextStickerPosition :one
SELECT (coalesce(max(position), -1) + 1)::integer FROM stickers WHERE pack_id = $1;

-- name: InsertSticker :one
INSERT INTO stickers (pack_id, file_id, emoji, position, width, height, animated)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: ListPackStickers :many
-- Live stickers of the packs with their file size, in pack order.
SELECT sqlc.embed(s), f.size AS file_size FROM stickers s
JOIN files f ON f.id = s.file_id
WHERE s.pack_id = ANY(sqlc.arg('pack_ids')::uuid[]) AND s.deleted_at IS NULL
ORDER BY s.pack_id, s.position, s.id;

-- name: ListStickersByID :many
-- Stickers shown by messages (deleted ones included) with their file size and workspace.
SELECT sqlc.embed(s), f.size AS file_size, p.workspace_id FROM stickers s
JOIN files f ON f.id = s.file_id
JOIN sticker_packs p ON p.id = s.pack_id
WHERE s.id = ANY(sqlc.arg('ids')::uuid[]);

-- name: GetSticker :one
-- A live sticker of a live pack, with its workspace.
SELECT sqlc.embed(s), f.size AS file_size, p.workspace_id FROM stickers s
JOIN files f ON f.id = s.file_id
JOIN sticker_packs p ON p.id = s.pack_id AND p.deleted_at IS NULL
WHERE s.id = $1 AND s.deleted_at IS NULL;

-- name: UpdateStickerEmoji :exec
UPDATE stickers SET emoji = $2 WHERE id = $1 AND deleted_at IS NULL;

-- name: DeleteStickerIfUnreferenced :execrows
DELETE FROM stickers s WHERE s.id = $1
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.sticker_id = s.id);

-- name: SoftDeleteSticker :exec
UPDATE stickers SET deleted_at = now() WHERE id = $1;

-- name: SetStickerPositions :exec
-- Positions 0.. in the given order (the caller passes the pack's complete live set).
UPDATE stickers s SET position = o.ord::integer - 1
FROM unnest(sqlc.arg('ids')::uuid[]) WITH ORDINALITY AS o(id, ord)
WHERE s.id = o.id AND s.pack_id = sqlc.arg('pack_id');

-- name: GetStickerFileWorkspace :one
-- The workspace of the pack whose sticker is this file (no row = not a sticker file).
SELECT p.workspace_id FROM stickers s JOIN sticker_packs p ON p.id = s.pack_id WHERE s.file_id = $1;

-- name: StickerFileRooms :many
-- Rooms where a live message shows the sticker of this file.
SELECT DISTINCT m.room_id FROM stickers s
JOIN messages m ON m.sticker_id = s.id AND m.deleted_at IS NULL
WHERE s.file_id = $1
LIMIT 50;

-- name: CountNonGuestMembers :one
-- How many of the users are members of the workspace with a role other than guest.
SELECT count(*)::integer FROM workspace_members
WHERE workspace_id = $1 AND user_id = ANY(sqlc.arg('user_ids')::uuid[]) AND role <> 'guest';

-- ---- the user's installed packs

-- name: ListUserStickerPacks :many
-- Installed live packs in the user's order, of workspaces where the user is not a guest.
SELECT p.* FROM user_sticker_packs u
JOIN sticker_packs p ON p.id = u.pack_id AND p.deleted_at IS NULL
JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = u.user_id AND m.role <> 'guest'
WHERE u.user_id = $1
ORDER BY u.position, u.added_at;

-- name: ListAvailableStickerPacks :many
-- Live packs of the user's workspaces (not as a guest) that the user has not installed.
SELECT p.* FROM sticker_packs p
JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = sqlc.arg('user_id') AND m.role <> 'guest'
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM user_sticker_packs u WHERE u.user_id = sqlc.arg('user_id') AND u.pack_id = p.id)
ORDER BY p.workspace_id, p.id
LIMIT 200;

-- name: CountUserStickerPacks :one
-- Counts what ListUserStickerPacks shows: installs of packs the user can no longer use (left
-- the workspace, became a guest there) neither count nor block the limit.
SELECT count(*)::integer FROM user_sticker_packs u
JOIN sticker_packs p ON p.id = u.pack_id AND p.deleted_at IS NULL
JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = u.user_id AND m.role <> 'guest'
WHERE u.user_id = $1;

-- name: InstallStickerPack :execrows
-- First in the user's order; 0 rows = already installed.
INSERT INTO user_sticker_packs (user_id, pack_id, position)
VALUES (sqlc.arg('user_id'), sqlc.arg('pack_id'),
        (SELECT coalesce(min(position), 1) - 1 FROM user_sticker_packs WHERE user_id = sqlc.arg('user_id')))
ON CONFLICT (user_id, pack_id) DO NOTHING;

-- name: UninstallStickerPack :execrows
DELETE FROM user_sticker_packs WHERE user_id = $1 AND pack_id = $2;

-- name: ListUserStickerPackIDs :many
-- The ids of ListUserStickerPacks (the set a reorder must list).
SELECT u.pack_id FROM user_sticker_packs u
JOIN sticker_packs p ON p.id = u.pack_id AND p.deleted_at IS NULL
JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = u.user_id AND m.role <> 'guest'
WHERE u.user_id = $1;

-- name: SetUserStickerPackOrder :exec
UPDATE user_sticker_packs u SET position = o.ord::integer - 1
FROM unnest(sqlc.arg('pack_ids')::uuid[]) WITH ORDINALITY AS o(id, ord)
WHERE u.user_id = sqlc.arg('user_id') AND u.pack_id = o.id;
