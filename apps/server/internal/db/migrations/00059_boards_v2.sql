-- Boards 2.0 (ADR-0058): board categories, board features, task checklists, the board webhook.
--
-- board_categories         categories of the boards list (separate from room_categories);
--                          boards.category_id NULL = «без категории».
-- boards.disabled_features bit mask of BoardFeature values switched off (bit = the enum value);
--                          0 = all on, so features added later are on for existing boards.
-- boards.estimate_scale    fibonacci | linear | tshirt.
-- task_checklists          named checklists of a task (≤ 10, enforced by the server).
-- task_checklist_items     items (≤ 100 per checklist); task_id is denormalized for counters.
-- board_webhooks           one webhook per board; secret sealed like the bot webhook secret;
--                          next_seq numbers the board's deliveries (the row lock serializes).
-- board_webhook_deliveries the outbox (ADR-0031 §4 pattern): due rows by next_at.
--
-- Safe on a populated database: tasks is not touched; boards only gets columns with constant
-- defaults (metadata-only since PG 11) and one partial index on a small table; every other
-- index is on a new, empty table.

-- +goose Up
-- ALTER TABLE boards takes ACCESS EXCLUSIVE: fail fast instead of queueing every board read
-- behind a long transaction (see 00055).
SET LOCAL lock_timeout = '10s';

CREATE TABLE board_categories (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    position     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_categories_workspace_idx ON board_categories (workspace_id, position);

ALTER TABLE boards
    ADD COLUMN category_id uuid REFERENCES board_categories (id) ON DELETE SET NULL,
    ADD COLUMN disabled_features bigint NOT NULL DEFAULT 0,
    ADD COLUMN estimate_scale text NOT NULL DEFAULT 'fibonacci'
        CHECK (estimate_scale IN ('fibonacci', 'linear', 'tshirt'));
CREATE INDEX boards_category_idx ON boards (category_id) WHERE category_id IS NOT NULL;

CREATE TABLE task_checklists (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    position   integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_checklists_task_idx ON task_checklists (task_id, position);
CREATE INDEX task_checklists_created_by_idx ON task_checklists (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE task_checklist_items (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    checklist_id uuid NOT NULL REFERENCES task_checklists (id) ON DELETE CASCADE,
    task_id      uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    text         text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
    done         boolean NOT NULL DEFAULT false,
    done_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    done_at      timestamptz,
    position     double precision NOT NULL DEFAULT 0,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (done OR (done_by IS NULL AND done_at IS NULL))
);
CREATE INDEX task_checklist_items_checklist_idx ON task_checklist_items (checklist_id, position);
CREATE INDEX task_checklist_items_task_idx ON task_checklist_items (task_id);
CREATE INDEX task_checklist_items_done_by_idx ON task_checklist_items (done_by) WHERE done_by IS NOT NULL;
CREATE INDEX task_checklist_items_created_by_idx ON task_checklist_items (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE board_webhooks (
    board_id      uuid PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
    url           text NOT NULL CHECK (url LIKE 'https://%' AND char_length(url) <= 2048),
    secret_enc    bytea NOT NULL,
    disabled_at   timestamptz,
    failing_since timestamptz,
    last_ok_at    timestamptz,
    last_error    text NOT NULL DEFAULT '',
    next_seq      bigint NOT NULL DEFAULT 1,
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_webhooks_created_by_idx ON board_webhooks (created_by) WHERE created_by IS NOT NULL;

CREATE TABLE board_webhook_deliveries (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id     uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    seq          bigint NOT NULL,
    event_type   text NOT NULL,
    payload      bytea,                     -- JSON body (BoardWebhookEvent); NULL once finished
    attempts     integer NOT NULL DEFAULT 0,
    next_at      timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    failed_at    timestamptz,
    error        text NOT NULL DEFAULT ''
);
CREATE INDEX board_webhook_deliveries_due_idx ON board_webhook_deliveries (next_at)
    WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX board_webhook_deliveries_board_idx ON board_webhook_deliveries (board_id, created_at);

-- +goose Down
SET LOCAL lock_timeout = '10s';
DROP TABLE board_webhook_deliveries;
DROP TABLE board_webhooks;
DROP TABLE task_checklist_items;
DROP TABLE task_checklists;
DROP INDEX boards_category_idx;
ALTER TABLE boards
    DROP COLUMN estimate_scale,
    DROP COLUMN disabled_features,
    DROP COLUMN category_id;
DROP TABLE board_categories;
