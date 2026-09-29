-- Calendar free / busy, finding a time and the user's CalDAV calendar (ADR-0041).
--
-- users.work_start_min / work_end_min / work_days   working hours in the user's zone
--                      (minutes from local midnight; days 1 = Monday … 7 = Sunday).
-- caldav_accounts      one CalDAV account per user: secret_enc is the password sealed with
--                      AES-GCM (sealbox «calaba/caldav/v1»); calendars caches the event
--                      calendars found at connection ([{href, name, color}]).
-- external_busy        busy time imported from that calendar (−1…+30 days): times only, no
--                      titles; uid is a hash of the VEVENT UID. Replaced on every import.
-- caldav_pushes        outbox of meetings to put into / delete from the user's calendar: one
--                      row per (user, event), the worker reads the event's current state;
--                      gen grows with every new change (a delivery of an older state does
--                      not remove a newer one).

-- +goose Up
ALTER TABLE users
    ADD COLUMN work_start_min smallint NOT NULL DEFAULT 600,
    ADD COLUMN work_end_min   smallint NOT NULL DEFAULT 1140,
    ADD COLUMN work_days      smallint[] NOT NULL DEFAULT '{1,2,3,4,5}',
    ADD CONSTRAINT users_work_hours_ck CHECK (work_start_min >= 0 AND work_start_min < work_end_min AND work_end_min <= 1440);

CREATE TABLE caldav_accounts (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    url           text NOT NULL CHECK (char_length(url) <= 2048),
    username      text NOT NULL CHECK (char_length(username) <= 256),
    secret_enc    bytea NOT NULL,
    calendars     jsonb NOT NULL DEFAULT '[]',
    calendar_href text CHECK (char_length(calendar_href) <= 2048),
    import        boolean NOT NULL DEFAULT true,
    push          boolean NOT NULL DEFAULT false,
    last_sync_at  timestamptz,
    last_error    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_busy (
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    uid       text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at   timestamptz NOT NULL,
    all_day   boolean NOT NULL DEFAULT false,
    CHECK (ends_at > starts_at)
);
CREATE INDEX external_busy_user_idx ON external_busy (user_id, starts_at);

CREATE TABLE caldav_pushes (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    event_id   uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    gen        bigint NOT NULL DEFAULT 1,
    attempts   integer NOT NULL DEFAULT 0,
    next_at    timestamptz NOT NULL DEFAULT now(),
    error      text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, event_id)
);
CREATE INDEX caldav_pushes_due_idx ON caldav_pushes (next_at);

-- +goose Down
DROP TABLE caldav_pushes;
DROP TABLE external_busy;
DROP TABLE caldav_accounts;
ALTER TABLE users DROP CONSTRAINT users_work_hours_ck,
    DROP COLUMN work_start_min, DROP COLUMN work_end_min, DROP COLUMN work_days;
