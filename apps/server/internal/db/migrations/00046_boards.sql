-- Task boards (ADR-0042, docs/04 «Доски задач»).
--
-- boards             a board of a workspace; key: the task key prefix (FNG), unique per workspace;
--                    next_number: the next task number (the row lock serializes numbering).
-- board_permissions  role / user overrides of the board bits, like room_permissions.
-- board_statuses     columns with a type (backlog … cancelled); one is_default per board.
-- board_labels, board_milestones, board_views (saved views; filter = TaskFilter JSON).
-- tasks              room_id: the task's hidden comment room (rooms.type 'task'); position: a
--                    fractional order within the status; search: words of title + description.
-- task_assignees     ≤ 10, exactly one is_lead when any.
-- task_labels, task_relations (blocks stored once), task_attachments (files of the description).
-- task_activity      the immutable journal (analytics later): removed only with the board.
-- task_subscribers   muted = «Отписаться»; notified_at / seen_at: the unread badge.
-- workspace_notification_settings.task_level: «Задачи» notifications (all | mentions | none).
-- Built-in member role: + VIEW_BOARD | CREATE_TASKS (1 << 17 | 1 << 18 = 393216).

-- +goose Up
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text', 'dm', 'notes', 'task'));

UPDATE workspace_roles SET permissions = permissions | 393216 WHERE builtin = 'member';

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

ALTER TABLE workspace_notification_settings
    ADD COLUMN task_level text NOT NULL DEFAULT 'all' CHECK (task_level IN ('all', 'mentions', 'none'));

CREATE TABLE boards (
    id                uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    key               text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,5}$'),
    emoji             text NOT NULL DEFAULT '',
    icon_file_id      uuid REFERENCES files (id) ON DELETE SET NULL,
    description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
    is_private        boolean NOT NULL DEFAULT false,
    position          integer NOT NULL DEFAULT 0,
    next_number       integer NOT NULL DEFAULT 1,
    auto_archive_days integer NOT NULL DEFAULT 30 CHECK (auto_archive_days BETWEEN 0 AND 3650),
    default_view_id   uuid,
    created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    archived_at       timestamptz
);
CREATE UNIQUE INDEX boards_key_uq ON boards (workspace_id, key);
CREATE INDEX boards_workspace_idx ON boards (workspace_id, position);
CREATE INDEX boards_icon_idx ON boards (icon_file_id) WHERE icon_file_id IS NOT NULL;

CREATE TABLE board_permissions (
    board_id    uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    target_type text NOT NULL CHECK (target_type IN ('role', 'user')),
    target_id   text NOT NULL,
    allow       bigint NOT NULL DEFAULT 0,
    deny        bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, target_type, target_id)
);

CREATE TABLE board_statuses (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
    type       text NOT NULL CHECK (type IN ('backlog', 'unstarted', 'started', 'completed', 'cancelled')),
    color      integer NOT NULL DEFAULT 0 CHECK (color BETWEEN 0 AND 16777215),
    position   integer NOT NULL DEFAULT 0,
    is_default boolean NOT NULL DEFAULT false
);
CREATE INDEX board_statuses_board_idx ON board_statuses (board_id, position);
CREATE UNIQUE INDEX board_statuses_default_uq ON board_statuses (board_id) WHERE is_default;

CREATE TABLE board_labels (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
    color    integer NOT NULL DEFAULT 0 CHECK (color BETWEEN 0 AND 16777215),
    position integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX board_labels_name_uq ON board_labels (board_id, lower(name));

CREATE TABLE board_milestones (
    id       uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name     text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    due_on   date,
    position integer NOT NULL DEFAULT 0
);
CREATE INDEX board_milestones_board_idx ON board_milestones (board_id, position);

CREATE TABLE board_views (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    kind       text NOT NULL CHECK (kind IN ('kanban', 'list', 'timeline')),
    filter     jsonb NOT NULL DEFAULT '{}',
    group_by   text NOT NULL DEFAULT '' CHECK (char_length(group_by) <= 32),
    sort       text NOT NULL DEFAULT '' CHECK (char_length(sort) <= 32),
    shared     boolean NOT NULL DEFAULT false,
    created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    position   integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX board_views_board_idx ON board_views (board_id, position);
CREATE INDEX board_views_created_by_idx ON board_views (created_by);
ALTER TABLE boards ADD CONSTRAINT boards_default_view_fk
    FOREIGN KEY (default_view_id) REFERENCES board_views (id) ON DELETE SET NULL;

CREATE TABLE tasks (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    board_id     uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    number       integer NOT NULL,
    title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 20000),
    status_id    uuid NOT NULL REFERENCES board_statuses (id),
    priority     smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    estimate     smallint CHECK (estimate BETWEEN 1 AND 21),
    start_on     date,
    due_on       date,
    parent_id    uuid REFERENCES tasks (id) ON DELETE SET NULL,
    milestone_id uuid REFERENCES board_milestones (id) ON DELETE SET NULL,
    position     double precision NOT NULL DEFAULT 0,
    room_id      uuid NOT NULL UNIQUE REFERENCES rooms (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    started_at   timestamptz,
    completed_at timestamptz,
    completed_by uuid REFERENCES users (id) ON DELETE SET NULL,
    archived_at  timestamptz,
    search       tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || description)) STORED,
    UNIQUE (board_id, number),
    CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX tasks_board_status_idx ON tasks (board_id, status_id, position) WHERE archived_at IS NULL;
CREATE INDEX tasks_board_archived_idx ON tasks (board_id, archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX tasks_parent_idx ON tasks (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX tasks_status_idx ON tasks (status_id);
CREATE INDEX tasks_milestone_idx ON tasks (milestone_id) WHERE milestone_id IS NOT NULL;
CREATE INDEX tasks_created_by_idx ON tasks (created_by);
CREATE INDEX tasks_search_idx ON tasks USING gin (search);
-- The auto-archive sweeper: finished live tasks by completion time.
CREATE INDEX tasks_completed_idx ON tasks (completed_at) WHERE archived_at IS NULL AND completed_at IS NOT NULL;

CREATE TABLE task_assignees (
    task_id     uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    is_lead     boolean NOT NULL DEFAULT false,
    note        text NOT NULL DEFAULT '' CHECK (char_length(note) <= 120),
    assigned_by uuid REFERENCES users (id) ON DELETE SET NULL,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, user_id)
);
CREATE UNIQUE INDEX task_assignees_lead_uq ON task_assignees (task_id) WHERE is_lead;
CREATE INDEX task_assignees_user_idx ON task_assignees (user_id);

CREATE TABLE task_labels (
    task_id  uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    label_id uuid NOT NULL REFERENCES board_labels (id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);
CREATE INDEX task_labels_label_idx ON task_labels (label_id);

CREATE TABLE task_relations (
    task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    related_id uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    kind       text NOT NULL CHECK (kind IN ('blocks', 'relates', 'duplicates')),
    created_by uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, related_id, kind),
    CHECK (task_id <> related_id)
);
CREATE INDEX task_relations_related_idx ON task_relations (related_id);

CREATE TABLE task_attachments (
    task_id  uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    file_id  uuid NOT NULL UNIQUE REFERENCES files (id) ON DELETE CASCADE,
    position smallint NOT NULL DEFAULT 0
);
CREATE INDEX task_attachments_task_idx ON task_attachments (task_id, position);

CREATE TABLE task_activity (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    task_id    uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    board_id   uuid NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    actor_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    kind       text NOT NULL,
    before     jsonb,
    after      jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_activity_task_idx ON task_activity (task_id, id);
CREATE INDEX task_activity_board_idx ON task_activity (board_id, created_at);
CREATE INDEX task_activity_actor_idx ON task_activity (actor_id, created_at);

CREATE TABLE task_subscribers (
    task_id     uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    muted       boolean NOT NULL DEFAULT false,
    notified_at timestamptz,
    seen_at     timestamptz,
    PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_subscribers_user_idx ON task_subscribers (user_id);
CREATE INDEX task_subscribers_unread_idx ON task_subscribers (user_id)
    WHERE notified_at IS NOT NULL AND (seen_at IS NULL OR notified_at > seen_at);

-- +goose Down
DROP TABLE task_subscribers;
DROP TABLE task_activity;
DROP TABLE task_attachments;
DROP TABLE task_relations;
DROP TABLE task_labels;
DROP TABLE task_assignees;
DROP TABLE tasks;
DELETE FROM rooms WHERE type = 'task';
ALTER TABLE boards DROP CONSTRAINT boards_default_view_fk;
DROP TABLE board_views;
DROP TABLE board_milestones;
DROP TABLE board_labels;
DROP TABLE board_statuses;
DROP TABLE board_permissions;
DROP TABLE boards;
ALTER TABLE workspace_notification_settings DROP COLUMN task_level;
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION workspace_builtin_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO workspace_roles (workspace_id, name, position, permissions, builtin) VALUES
        (NEW.id, 'owner', 1001, 1024, 'owner'),
        (NEW.id, 'admin', 1000, 1024, 'admin'),
        (NEW.id, 'member', 1, 16503, 'member'),
        (NEW.id, 'guest', 0, 48, 'guest');
    RETURN NULL;
END
$$;
-- +goose StatementEnd
UPDATE workspace_roles SET permissions = permissions & ~2031616::bigint WHERE builtin IS NOT NULL OR permissions & 2031616 <> 0;
ALTER TABLE rooms DROP CONSTRAINT rooms_type_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_type_check CHECK (type IN ('voice', 'text', 'dm', 'notes'));
