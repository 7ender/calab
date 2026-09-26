-- Rooms: one explicit order, categories only when a user makes them (docs/09 P1 #19).
--
-- Until now a workspace without categories was shown as two client-side sections («Текстовые
-- комнаты» / «Голосовые комнаты», text first, then voice, each by position), and inside every
-- category text rooms came before voice rooms too. From now on the sidebar is ordered by
-- `position` alone (drag & drop can interleave text and voice rooms), so:
--
-- 1. Default-named categories created together with their workspace (within a minute of it)
--    are dissolved: such a category was never chosen by a user. Anything renamed, created
--    later or named otherwise is a user category and stays.
-- 2. Every container (top level, each remaining category) gets contiguous positions 0..n-1 in
--    the order the sidebar showed until now: former top-level rooms first, then the rooms of the
--    dissolved categories (by category position); within each group text before voice, then
--    by position, name and id.
-- Archived rooms and DMs (workspace_id NULL) are not touched beyond losing a dissolved category.

-- +goose Up
CREATE TEMP TABLE dissolved_categories ON COMMIT DROP AS
SELECT c.id,
       row_number() OVER (PARTITION BY c.workspace_id ORDER BY c.position, c.id) AS rank
FROM room_categories c
JOIN workspaces w ON w.id = c.workspace_id
WHERE c.name IN ('Текстовые комнаты', 'Голосовые комнаты', 'Text rooms', 'Voice rooms',
                 'Salas de texto', 'Salas de voz', '文字房间', '语音房间')
  AND c.created_at < w.created_at + interval '1 minute';

WITH ordered AS (
    SELECT r.id,
           CASE WHEN d.id IS NULL THEN r.category_id END AS new_category,
           row_number() OVER (
               PARTITION BY r.workspace_id, CASE WHEN d.id IS NULL THEN r.category_id END
               ORDER BY coalesce(d.rank, 0),
                        (r.type = 'voice'),
                        r.position, r.name, r.id
           ) - 1 AS new_position
    FROM rooms r
    LEFT JOIN dissolved_categories d ON d.id = r.category_id
    WHERE r.workspace_id IS NOT NULL AND r.archived_at IS NULL
)
UPDATE rooms r
SET position = o.new_position, category_id = o.new_category
FROM ordered o
WHERE r.id = o.id
  AND (r.position IS DISTINCT FROM o.new_position OR r.category_id IS DISTINCT FROM o.new_category);

-- Archived rooms of dissolved categories: ON DELETE SET NULL clears their category.
DELETE FROM room_categories WHERE id IN (SELECT id FROM dissolved_categories);

-- +goose Down
-- Irreversible by design: the dissolved categories held no user data (default names, created
-- with the workspace) and the old text-before-voice order is a subset of the new one.
SELECT 1;
