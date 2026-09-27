-- Workspace suspension by a superadmin and member bans (backlog item 32, ADR-0024 admin API).
--
-- workspaces.suspended_*: a suspended workspace is read-only — sending / editing messages,
--   reactions, files, voice, streams / cameras, invitations and recording are refused with
--   403 WORKSPACE_SUSPENDED. suspended_reason is shown to the owner / admins only.
-- workspace_admin_log: every suspend / resume made through the admin API (the plan changes
--   stay in workspace_plan_log).
-- workspace_bans: a banned user is removed and cannot come back — by invitation, open join,
--   email invitation or a room link. email is the account's address at ban time (if any):
--   it also blocks registering with an invitation and email invitations to it.

-- +goose Up
ALTER TABLE workspaces
    ADD COLUMN suspended_at     timestamptz,
    ADD COLUMN suspended_reason text NOT NULL DEFAULT '' CHECK (char_length(suspended_reason) <= 500),
    ADD COLUMN suspended_by     uuid REFERENCES users (id) ON DELETE SET NULL;
CREATE INDEX workspaces_suspended_by_idx ON workspaces (suspended_by) WHERE suspended_by IS NOT NULL;

CREATE TABLE workspace_admin_log (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    action       text NOT NULL CHECK (action IN ('suspend', 'resume')),
    reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_admin_log_workspace_id_idx ON workspace_admin_log (workspace_id, id DESC);
CREATE INDEX workspace_admin_log_actor_id_idx ON workspace_admin_log (actor_id) WHERE actor_id IS NOT NULL;

CREATE TABLE workspace_bans (
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email        citext,
    reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 500),
    banned_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_bans_email_idx ON workspace_bans (workspace_id, email) WHERE email IS NOT NULL;
CREATE INDEX workspace_bans_user_id_idx ON workspace_bans (user_id);
CREATE INDEX workspace_bans_banned_by_idx ON workspace_bans (banned_by) WHERE banned_by IS NOT NULL;

-- +goose Down
DROP TABLE workspace_bans;
DROP TABLE workspace_admin_log;
ALTER TABLE workspaces DROP COLUMN suspended_by, DROP COLUMN suspended_reason, DROP COLUMN suspended_at;
