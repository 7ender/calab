-- Birthdays (docs/09 #76, as in Telegram): day and month (set together), the year optional;
-- birthday_hidden keeps the date to its owner (User.birthday is sent to nobody else).
-- 29 February is a valid birthday (celebrated on 28 February in other years); the full date
-- (with the year) is checked by the API, the columns only bound each part.
-- birthday_greetings: the hourly worker posts one card per (user, workspace, local date) —
-- the primary key is the dedup, the insert claims the card across instances.

-- +goose Up
ALTER TABLE users
    ADD COLUMN birthday_day    smallint CHECK (birthday_day BETWEEN 1 AND 31),
    ADD COLUMN birthday_month  smallint CHECK (birthday_month BETWEEN 1 AND 12),
    ADD COLUMN birthday_year   smallint CHECK (birthday_year BETWEEN 1900 AND 2100),
    ADD COLUMN birthday_hidden boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT users_birthday_complete CHECK (
        (birthday_day IS NULL) = (birthday_month IS NULL)
        AND (birthday_year IS NULL OR birthday_day IS NOT NULL));

CREATE INDEX users_birthday_idx ON users ((birthday_month * 100 + birthday_day)) WHERE birthday_day IS NOT NULL;

CREATE TABLE birthday_greetings (
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    day          date NOT NULL, -- the celebrant's local date
    message_id   uuid,          -- the posted card (no foreign key: the card may be deleted)
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, workspace_id, day)
);

-- +goose Down
DROP TABLE birthday_greetings;
ALTER TABLE users
    DROP CONSTRAINT users_birthday_complete,
    DROP COLUMN birthday_hidden,
    DROP COLUMN birthday_year,
    DROP COLUMN birthday_month,
    DROP COLUMN birthday_day;
