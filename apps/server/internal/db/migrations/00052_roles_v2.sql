-- Roles v2 (ADR-0048): permissions by function and boards closed even to administrators.
--
-- Seven workspace-level bits split off MANAGE_WORKSPACE (512): CREATE_BOARDS (1 << 25),
-- MANAGE_MEMBERS (1 << 26), MANAGE_BOTS (1 << 27), MANAGE_INTEGRATIONS (1 << 28),
-- VIEW_JOURNALS (1 << 29), MANAGE_EVENTS (1 << 30), MANAGE_RECORDINGS (1 << 31); together
-- 4261412864. Nobody loses a capability on upgrade: every role holding MANAGE_WORKSPACE gets all
-- seven (built-in owner / admin hold ADMINISTRATOR = everything anyway); the member and guest
-- roles get none. Overrides never carry them (workspace-level).
--
-- boards.restricted: like rooms.restricted (ADR-0029, migration 00024), only on a private board.
-- rooms.restricted exists since 00024; its rule changes in code only (VIEW_ROOM from overrides).

-- +goose Up
UPDATE workspace_roles SET permissions = permissions | 4261412864 WHERE permissions & 512 <> 0;
ALTER TABLE boards
    ADD COLUMN restricted boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT boards_restricted_private CHECK (NOT restricted OR is_private);

-- +goose Down
ALTER TABLE boards DROP CONSTRAINT boards_restricted_private, DROP COLUMN restricted;
UPDATE workspace_roles SET permissions = permissions & ~4261412864::bigint WHERE permissions & 4261412864 <> 0;
