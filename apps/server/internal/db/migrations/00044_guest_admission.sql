-- Guest admission, a «waiting room» for room links (ADR-0040).
--
-- rooms.guest_approval         guests arriving by a link of the room wait for a decision.
-- room_invites.require_approval per-link override: NULL = as the room, true / false = this link.
-- room_admissions              one knock per (room, user): pending → admitted | declined. A
--                              declined row is kept 10 minutes (no new knock before that after
--                              a human decline); pending older than 30 minutes is declined by
--                              the sweeper (decided_by NULL = nobody answered).

-- +goose Up
ALTER TABLE rooms ADD COLUMN guest_approval boolean NOT NULL DEFAULT false;
ALTER TABLE room_invites ADD COLUMN require_approval boolean;

CREATE TABLE room_admissions (
    room_id      uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    invite_id    uuid REFERENCES room_invites (id) ON DELETE SET NULL,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'admitted', 'declined')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_at   timestamptz,
    PRIMARY KEY (room_id, user_id)
);
CREATE INDEX room_admissions_user_idx ON room_admissions (user_id);
-- The sweeper's scans: stale pending knocks and expired declines.
CREATE INDEX room_admissions_pending_idx ON room_admissions (requested_at) WHERE status = 'pending';
CREATE INDEX room_admissions_declined_idx ON room_admissions (decided_at) WHERE status = 'declined';

-- +goose Down
DROP TABLE room_admissions;
ALTER TABLE room_invites DROP COLUMN require_approval;
ALTER TABLE rooms DROP COLUMN guest_approval;
