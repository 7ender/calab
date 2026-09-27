-- ADR-0023: workspace invitations sent by email. The link is an ordinary single-use
-- workspace invite (/join/<code>) bound to the address through this row.

-- +goose Up
CREATE TABLE email_invites (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    email        citext NOT NULL,
    role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    invited_by   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    invite_id    uuid NOT NULL UNIQUE REFERENCES workspace_invites (id) ON DELETE CASCADE,
    expires_at   timestamptz NOT NULL,
    last_sent_at timestamptz NOT NULL DEFAULT now(),
    accepted_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- At most one pending invitation per address and workspace.
CREATE UNIQUE INDEX email_invites_pending_key ON email_invites (workspace_id, email) WHERE accepted_at IS NULL;
CREATE INDEX email_invites_email_idx ON email_invites (email) WHERE accepted_at IS NULL;
CREATE INDEX email_invites_invited_by_idx ON email_invites (invited_by);

-- +goose Down
DROP TABLE email_invites;
