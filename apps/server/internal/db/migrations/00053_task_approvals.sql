-- Task approvals (ADR-0049).
--
-- tasks.approval_required: approvals needed, 0 = all approvers; the effective quorum is
-- min(approval_required, number of approvers). The task's state (none | pending | approved |
-- rejected) is derived, never stored.
-- task_approvers: ≤ 10 per task (checked by the server); state pending | approved | rejected,
-- comment ≤ 500 (required for rejected). requested_at: when the vote was last asked for (added,
-- reset, withdrawn); reminders / reminded_at: the daily reminder of a pending vote (≤ 3).

-- +goose Up
ALTER TABLE tasks ADD COLUMN approval_required smallint NOT NULL DEFAULT 0
    CONSTRAINT tasks_approval_required_check CHECK (approval_required BETWEEN 0 AND 10);

CREATE TABLE task_approvers (
    task_id      uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected')),
    comment      text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
    decided_at   timestamptz,
    added_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    added_at     timestamptz NOT NULL DEFAULT now(),
    requested_at timestamptz NOT NULL DEFAULT now(),
    reminders    smallint NOT NULL DEFAULT 0,
    reminded_at  timestamptz,
    PRIMARY KEY (task_id, user_id),
    CONSTRAINT task_approvers_reject_comment CHECK (state <> 'rejected' OR comment <> '')
);
CREATE INDEX task_approvers_pending_idx ON task_approvers (user_id) WHERE state = 'pending';

-- +goose Down
DROP TABLE task_approvers;
ALTER TABLE tasks DROP COLUMN approval_required;
