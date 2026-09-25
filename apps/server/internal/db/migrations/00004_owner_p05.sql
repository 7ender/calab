-- P0.5 (docs/09 #31-35, ADR-0016): room user limit, self nicknames, guests, room links.

-- +goose Up
ALTER TABLE rooms ADD COLUMN user_limit integer NOT NULL DEFAULT 0 CHECK (user_limit BETWEEN 0 AND 99);
ALTER TABLE workspaces ADD COLUMN allow_self_nickname boolean NOT NULL DEFAULT true;

-- Guest accounts: no email / password; removed (anonymised) after 7 days without activity.
ALTER TABLE users
    ALTER COLUMN email DROP NOT NULL,
    ADD COLUMN is_guest boolean NOT NULL DEFAULT false,
    ADD COLUMN guest_expires_at timestamptz,
    ADD CONSTRAINT users_email_or_guest CHECK (email IS NOT NULL OR is_guest);
CREATE INDEX users_guest_expires_idx ON users (guest_expires_at) WHERE is_guest AND guest_expires_at IS NOT NULL;

CREATE TABLE room_invites (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    room_id      uuid NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    code         text NOT NULL UNIQUE,
    created_by   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at   timestamptz,
    max_uses     integer NOT NULL DEFAULT 0 CHECK (max_uses >= 0),
    uses         integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
    allow_guests boolean NOT NULL DEFAULT true,
    allow_bits   bigint NOT NULL,          -- Permission bits granted to joiners in the room
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_invites_room_id_idx ON room_invites (room_id);

-- +goose Down
DROP TABLE room_invites;
DROP INDEX users_guest_expires_idx;
DELETE FROM users WHERE email IS NULL;
ALTER TABLE users DROP CONSTRAINT users_email_or_guest, DROP COLUMN guest_expires_at, DROP COLUMN is_guest,
    ALTER COLUMN email SET NOT NULL;
ALTER TABLE workspaces DROP COLUMN allow_self_nickname;
ALTER TABLE rooms DROP COLUMN user_limit;
