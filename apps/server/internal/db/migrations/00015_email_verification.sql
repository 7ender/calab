-- ADR-0023: email verification, password reset codes and the mail outbox.
-- New columns are nullable (metadata-only, no table rewrite). No grandfathering (owner,
-- 27.09): existing accounts stay unverified (email_verified_at NULL) until they confirm.

-- +goose Up
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
-- Requested new login address, waiting for its code (PATCH /api/me/email).
ALTER TABLE users ADD COLUMN pending_email citext;
-- Language of emails; NULL = English.
ALTER TABLE users ADD COLUMN locale text CHECK (locale IN ('en', 'ru', 'es', 'zh-CN'));

-- One active code per (user, purpose); sending a new one replaces it.
CREATE TABLE email_codes (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    text NOT NULL CHECK (purpose IN ('verify', 'change', 'reset')),
    code_hash  text NOT NULL,                             -- argon2id (PHC string)
    expires_at timestamptz NOT NULL,
    attempts   integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, purpose)
);

-- Outgoing mail, sent by one worker at a time (Valkey lock) with retries for up to 24 h.
-- params: AES-GCM sealed JSON (codes and invite links are secrets); cleared once done.
CREATE TABLE mail_outbox (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    to_addr    text NOT NULL,
    template   text NOT NULL,
    locale     text NOT NULL,
    params     bytea,
    priority   smallint NOT NULL DEFAULT 1,               -- 0 = codes first, 1 = notifications
    attempts   integer NOT NULL DEFAULT 0,
    next_at    timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,                      -- give up after this (code / link lifetime, ≤ 24 h)
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz,
    failed_at  timestamptz,
    error      text NOT NULL DEFAULT ''
);
CREATE INDEX mail_outbox_due_idx ON mail_outbox (priority, next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE INDEX mail_outbox_created_at_idx ON mail_outbox (created_at);

-- +goose Down
DROP TABLE mail_outbox;
DROP TABLE email_codes;
ALTER TABLE users DROP COLUMN locale;
ALTER TABLE users DROP COLUMN pending_email;
ALTER TABLE users DROP COLUMN email_verified_at;
