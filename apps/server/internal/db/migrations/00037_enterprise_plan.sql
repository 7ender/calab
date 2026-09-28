-- Enterprise plan (ADR-0024 «Пометка 2026-09-28 (2)»): a cloud plan without any limits.

-- +goose Up
ALTER TABLE workspace_plans DROP CONSTRAINT workspace_plans_plan_check,
    ADD CONSTRAINT workspace_plans_plan_check CHECK (plan IN ('free', 'team', 'custom', 'enterprise'));
ALTER TABLE workspace_plan_log DROP CONSTRAINT workspace_plan_log_plan_check,
    ADD CONSTRAINT workspace_plan_log_plan_check CHECK (plan IN ('free', 'team', 'custom', 'enterprise'));

-- +goose Down
UPDATE workspace_plans SET plan = 'custom', limits = '{}' WHERE plan = 'enterprise';
UPDATE workspace_plan_log SET plan = 'custom' WHERE plan = 'enterprise';
ALTER TABLE workspace_plans DROP CONSTRAINT workspace_plans_plan_check,
    ADD CONSTRAINT workspace_plans_plan_check CHECK (plan IN ('free', 'team', 'custom'));
ALTER TABLE workspace_plan_log DROP CONSTRAINT workspace_plan_log_plan_check,
    ADD CONSTRAINT workspace_plan_log_plan_check CHECK (plan IN ('free', 'team', 'custom'));
