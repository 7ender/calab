-- ADR-0058 §1: categories of the boards list (separate from room_categories).

-- name: ListBoardCategories :many
SELECT * FROM board_categories WHERE workspace_id = $1 ORDER BY position, id;

-- name: GetBoardCategory :one
SELECT * FROM board_categories WHERE id = $1;

-- name: CountBoardCategories :one
SELECT count(*)::integer FROM board_categories WHERE workspace_id = $1;

-- name: CreateBoardCategory :one
-- position NULL = last. Serialize with LockBoards (count limit, positions).
INSERT INTO board_categories (workspace_id, name, position)
VALUES (sqlc.arg('workspace_id'), sqlc.arg('name'),
        coalesce(sqlc.narg('position')::integer,
                 (SELECT coalesce(max(position) + 1, 0) FROM board_categories WHERE workspace_id = sqlc.arg('workspace_id'))))
RETURNING *;

-- name: UpdateBoardCategory :one
UPDATE board_categories SET
    name     = coalesce(sqlc.narg('name'), name),
    position = coalesce(sqlc.narg('position'), position)
WHERE id = sqlc.arg('id')
RETURNING *;

-- name: SetBoardCategoryPosition :one
UPDATE board_categories SET position = sqlc.arg('position')
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')
RETURNING *;

-- name: DeleteBoardCategory :many
-- Deletes a category; returns the boards that were in it (live and archived). They move to
-- «без категории» after the boards already there, in their order: no position ties.
WITH base AS (
    SELECT coalesce(max(b.position) + 1, 0) AS p FROM boards b
    WHERE b.workspace_id = (SELECT c.workspace_id FROM board_categories c WHERE c.id = sqlc.arg('id')::uuid)
      AND b.category_id IS NULL
), ordered AS (
    SELECT b.id, row_number() OVER (ORDER BY b.position, b.id) - 1 AS n FROM boards b
    WHERE b.category_id = sqlc.arg('id')::uuid
), moved AS (
    UPDATE boards SET category_id = NULL, position = base.p + ordered.n
    FROM base, ordered
    WHERE boards.id = ordered.id
    RETURNING boards.id
), gone AS (
    DELETE FROM board_categories WHERE board_categories.id = sqlc.arg('id')::uuid
)
SELECT id FROM moved;

-- name: SetBoardPlacement :one
-- Puts a board into a category of its workspace (NULL = none) at a position (boards/order,
-- PUT /boards/{id}/position with category_id).
UPDATE boards SET position = sqlc.arg('position'), category_id = sqlc.narg('category_id')
WHERE id = sqlc.arg('id') AND workspace_id = sqlc.arg('workspace_id')::uuid
RETURNING *;
