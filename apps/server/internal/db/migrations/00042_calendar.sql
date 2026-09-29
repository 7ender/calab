-- Workspace calendar and meetings (ADR-0038, docs/04 «Календарь»).
--
-- events               a meeting or a series. Times are UTC; `tz` is the organizer's zone
--                      (repeats keep its wall-clock time). rrule: RFC 5545 subset
--                      (FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL=2 for WEEKLY, UNTIL=…Z).
--                      until_at: the latest end of any occurrence (single: ends_at; series with
--                      UNTIL: the last occurrence's end; NULL = endless series) — the sweeper and
--                      lists skip finished events with it. sequence: iCalendar SEQUENCE.
-- event_attendees      a workspace member (user_id) or an external address (email), exactly
--                      one; invite_id: the external attendee's meeting guest link (ADR-0016).
-- event_exceptions     cancelled occurrences of a series (by their start).
-- event_reminders_sent dedup of EVENT_REMINDER per occurrence, user and minutes.
-- event_room_signals   dedup of ROOM_EVENT_ACTIVE / ROOM_EVENT_ENDED per occurrence.
-- event_recordings     recording of an occurrence (started by the organizer in its window).
-- users.event_reminders / event_reminders_dnd: reminder minutes and «remind during DND».
-- room_invites.not_before / event_id: meeting guest links work from 15 min before the start.

-- +goose Up
ALTER TABLE users
    ADD COLUMN event_reminders     smallint[] NOT NULL DEFAULT '{60,5}',
    ADD COLUMN event_reminders_dnd boolean NOT NULL DEFAULT true;

CREATE TABLE events (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    room_id      uuid REFERENCES rooms (id) ON DELETE SET NULL,
    title        text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
    description  text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL,
    all_day      boolean NOT NULL DEFAULT false,
    tz           text NOT NULL CHECK (char_length(tz) BETWEEN 1 AND 64),
    organizer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    record       boolean NOT NULL DEFAULT false,
    rrule        text CHECK (char_length(rrule) <= 200),
    until_at     timestamptz,
    sequence     integer NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    cancelled_at timestamptz,
    CHECK (ends_at > starts_at)
);
CREATE INDEX events_workspace_idx ON events (workspace_id, starts_at) WHERE cancelled_at IS NULL;
CREATE INDEX events_due_idx ON events (starts_at) WHERE cancelled_at IS NULL;
CREATE INDEX events_room_idx ON events (room_id) WHERE cancelled_at IS NULL AND room_id IS NOT NULL;
CREATE INDEX events_organizer_idx ON events (organizer_id) WHERE cancelled_at IS NULL;

ALTER TABLE room_invites
    ADD COLUMN not_before timestamptz,
    ADD COLUMN event_id   uuid REFERENCES events (id) ON DELETE CASCADE;

CREATE TABLE event_attendees (
    event_id     uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    user_id      uuid REFERENCES users (id) ON DELETE CASCADE,
    email        citext CHECK (char_length(email) <= 254),
    required     boolean NOT NULL DEFAULT true,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'maybe')),
    responded_at timestamptz,
    invite_id    uuid REFERENCES room_invites (id) ON DELETE SET NULL,
    CHECK ((user_id IS NULL) <> (email IS NULL))
);
CREATE UNIQUE INDEX event_attendees_user_uq ON event_attendees (event_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX event_attendees_email_uq ON event_attendees (event_id, email) WHERE email IS NOT NULL;
CREATE INDEX event_attendees_user_idx ON event_attendees (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE event_exceptions (
    event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence_at timestamptz NOT NULL,
    PRIMARY KEY (event_id, occurrence_at)
);

CREATE TABLE event_reminders_sent (
    event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence_at timestamptz NOT NULL,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    minutes       smallint NOT NULL,
    sent_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurrence_at, user_id, minutes)
);
CREATE INDEX event_reminders_sent_at_idx ON event_reminders_sent (sent_at);

CREATE TABLE event_room_signals (
    event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence_at timestamptz NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('active', 'ended')),
    sent_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, occurrence_at, kind)
);
CREATE INDEX event_room_signals_sent_at_idx ON event_room_signals (sent_at);

CREATE TABLE event_recordings (
    event_id      uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    occurrence_at timestamptz NOT NULL,
    recording_id  uuid NOT NULL REFERENCES room_recordings (id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, occurrence_at)
);

-- +goose Down
DROP TABLE event_recordings;
DROP TABLE event_room_signals;
DROP TABLE event_reminders_sent;
DROP TABLE event_exceptions;
DROP TABLE event_attendees;
ALTER TABLE room_invites DROP COLUMN not_before, DROP COLUMN event_id;
DROP TABLE events;
ALTER TABLE users DROP COLUMN event_reminders, DROP COLUMN event_reminders_dnd;
