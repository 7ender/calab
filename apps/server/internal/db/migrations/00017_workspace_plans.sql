-- Workspace plans and limits (ADR-0024). A workspace without a row is on the free plan.
-- limits: only for plan 'custom' (JSON, see internal/plans); free / team take theirs from
-- PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS. An expired valid_until means free limits (the row
-- stays). workspace_plan_log keeps every change made through the admin API.

-- +goose Up
CREATE TABLE workspace_plans (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    plan         text NOT NULL CHECK (plan IN ('free', 'team', 'custom')),
    limits       jsonb CHECK (limits IS NULL OR jsonb_typeof(limits) = 'object'),
    valid_until  timestamptz,
    note         text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
    updated_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_plans_updated_by_idx ON workspace_plans (updated_by) WHERE updated_by IS NOT NULL;

CREATE TABLE workspace_plan_log (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    plan         text NOT NULL CHECK (plan IN ('free', 'team', 'custom')),
    limits       jsonb NOT NULL,
    valid_until  timestamptz,
    note         text NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_plan_log_workspace_id_idx ON workspace_plan_log (workspace_id, id DESC);
-- ON DELETE SET NULL from users.id needs its own index.
CREATE INDEX workspace_plan_log_actor_id_idx ON workspace_plan_log (actor_id) WHERE actor_id IS NOT NULL;

-- +goose Down
DROP TABLE workspace_plan_log;
DROP TABLE workspace_plans;
