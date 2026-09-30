-- Telephony: outbound SIP calls from voice rooms (ADR-0046).
--
-- sip_accounts   one SIP provider account per workspace; host is without the port (port column),
--                auth_username '' = authenticate as username. password_enc is sealed with sealbox
--                ("calaba/sip-password/v1", like the CalDAV password of ADR-0041); trunk_id is
--                the LiveKit SIPOutboundTrunk made from the row ('' = none). The row always
--                matches what LiveKit holds: a save LiveKit refuses changes only last_error.
-- sip_calls      the call journal (analytics, later billing). Kept when the room goes
--                (room_id SET NULL); room_id NULL from the start = a connection test.
--                At most one live (dialing / ringing / active) call per room.
-- workspaces.sip_enabled  enabled AND trunk_id <> '' of the account, kept by the SIP handlers
--                in the same transaction: Workspace.sip_enabled for clients without a join.
-- PLACE_CALLS (1 << 24 = 16777216): no built-in role gets it (calls cost money); the owner and
-- admins have it through ADMINISTRATOR.

-- +goose Up
CREATE TABLE sip_accounts (
    workspace_id     uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
    provider         text NOT NULL DEFAULT '',
    host             text NOT NULL DEFAULT '',
    transport        text NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp', 'tls')),
    username         text NOT NULL DEFAULT '',
    auth_username    text NOT NULL DEFAULT '',
    port             integer NOT NULL DEFAULT 5060 CHECK (port BETWEEN 1 AND 65535),
    password_enc     bytea,
    caller_id        text NOT NULL DEFAULT '',
    outbound_prefix  text NOT NULL DEFAULT '',
    allowed_prefixes text[] NOT NULL DEFAULT '{}',
    trunk_id         text NOT NULL DEFAULT '',
    enabled          boolean NOT NULL DEFAULT false,
    last_error       text NOT NULL DEFAULT '',
    updated_at       timestamptz NOT NULL DEFAULT now(),
    updated_by       uuid REFERENCES users (id) ON DELETE SET NULL
);

CREATE TABLE sip_calls (
    id                   uuid PRIMARY KEY,
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    room_id              uuid REFERENCES rooms (id) ON DELETE SET NULL,
    number               text NOT NULL,
    direction            text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in')),
    started_by           uuid REFERENCES users (id) ON DELETE SET NULL,
    participant_identity text NOT NULL DEFAULT '',
    sip_call_id          text NOT NULL DEFAULT '',
    status               text NOT NULL DEFAULT 'dialing'
        CHECK (status IN ('dialing', 'ringing', 'active', 'ended', 'failed')),
    reason               text NOT NULL DEFAULT '',
    ended_by             uuid REFERENCES users (id) ON DELETE SET NULL,
    started_at           timestamptz NOT NULL DEFAULT now(),
    answered_at          timestamptz,
    ended_at             timestamptz
);
-- One live call per room; also what places a call atomically (a concurrent second insert fails).
CREATE UNIQUE INDEX sip_calls_room_live_idx ON sip_calls (room_id)
    WHERE status IN ('dialing', 'ringing', 'active');
-- The journal: newest first per workspace.
CREATE INDEX sip_calls_workspace_idx ON sip_calls (workspace_id, id DESC);
-- The sweeper of lost calls.
CREATE INDEX sip_calls_live_idx ON sip_calls (started_at) WHERE status IN ('dialing', 'ringing', 'active');

ALTER TABLE workspaces ADD COLUMN sip_enabled boolean NOT NULL DEFAULT false;

-- +goose Down
UPDATE workspace_roles SET permissions = permissions & ~16777216::bigint WHERE permissions & 16777216 <> 0;
UPDATE room_permissions SET allow = allow & ~16777216::bigint, deny = deny & ~16777216::bigint
WHERE (allow | deny) & 16777216 <> 0;
ALTER TABLE workspaces DROP COLUMN sip_enabled;
DROP TABLE sip_calls;
DROP TABLE sip_accounts;
