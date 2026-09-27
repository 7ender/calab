-- Bots and the Bot API (ADR-0031). A bot is a user (users.is_bot) without email or password,
-- created in a workspace ("home", bots.workspace_id) by its owner / a MANAGE_WORKSPACE member,
-- member of that workspace (and of the ones an admin adds it to) with the built-in role
-- member; rights come only from roles and room overrides, as for people.
--
-- Token: calab_bot_<user_id>_<secret>; only sha256(secret) is stored (token_hash). token_id
-- is the bot's "session": it is regenerated on every reissue and plays the role of
-- sessions.id for the gateway (one device), LiveKit identities (<user_id>:<token_id>) and
-- revocation (auth:revoked:<token_id>). token_hash NULL = no valid token (revoked).
-- token_prefix: the first characters of the secret, shown in the settings to tell tokens
-- apart (never enough to use one).
--
-- Webhook: outbox bot_webhook_deliveries (a worker POSTs the JSON with an HMAC signature,
-- backoff 1 min → 1 h); after a day of failures the webhook is disabled (webhook_disabled_at).
-- The secret is sealed (AES-GCM, key from JWT_SECRET, purpose calaba/bot-webhook/v1).
--
-- bot_blocks: a person blocked a bot; the bot gets 403 BOT_BLOCKED on DMs to them.

-- +goose Up
ALTER TABLE users ADD COLUMN is_bot boolean NOT NULL DEFAULT false;
ALTER TABLE users
    DROP CONSTRAINT users_email_or_guest,
    ADD CONSTRAINT users_email_or_guest CHECK (email IS NOT NULL OR is_guest OR is_bot),
    ADD CONSTRAINT users_bot_not_guest CHECK (NOT (is_bot AND is_guest));

CREATE TABLE bots (
    user_id               uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    owner_user_id         uuid NOT NULL REFERENCES users (id),
    workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    username              citext NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
    description           text NOT NULL DEFAULT '' CHECK (char_length(description) <= 512),
    token_id              uuid,
    token_hash            bytea,
    token_prefix          text NOT NULL DEFAULT '',
    webhook_url           text,
    webhook_secret_enc    bytea,
    webhook_disabled_at   timestamptz,
    webhook_failing_since timestamptz,
    webhook_last_ok_at    timestamptz,
    webhook_last_error    text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    revoked_at            timestamptz,
    CHECK ((token_hash IS NULL) = (token_id IS NULL)),
    CHECK ((webhook_url IS NULL) = (webhook_secret_enc IS NULL))
);
CREATE INDEX bots_workspace_id_idx ON bots (workspace_id);
CREATE INDEX bots_owner_user_id_idx ON bots (owner_user_id);
CREATE INDEX bots_webhook_idx ON bots (user_id) WHERE webhook_url IS NOT NULL AND webhook_disabled_at IS NULL;

CREATE TABLE bot_commands (
    bot_user_id uuid NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,32}$'),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 256),
    position    smallint NOT NULL,
    PRIMARY KEY (bot_user_id, name)
);

CREATE TABLE bot_webhook_deliveries (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    bot_user_id  uuid NOT NULL REFERENCES bots (user_id) ON DELETE CASCADE,
    payload      bytea,                     -- JSON body (BotWebhookUpdate); NULL once finished
    attempts     integer NOT NULL DEFAULT 0,
    next_at      timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz,
    failed_at    timestamptz,
    error        text NOT NULL DEFAULT ''
);
CREATE INDEX bot_webhook_deliveries_due_idx ON bot_webhook_deliveries (next_at)
    WHERE delivered_at IS NULL AND failed_at IS NULL;
CREATE INDEX bot_webhook_deliveries_bot_idx ON bot_webhook_deliveries (bot_user_id);

CREATE TABLE bot_blocks (
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    bot_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, bot_user_id)
);

-- +goose Down
DROP TABLE bot_blocks;
DROP TABLE bot_webhook_deliveries;
DROP TABLE bot_commands;
DROP TABLE bots;
ALTER TABLE users DROP CONSTRAINT users_bot_not_guest;
-- Former bots keep their messages: they become (disabled) accounts without email, like guests.
UPDATE users SET is_guest = true, disabled_at = coalesce(disabled_at, now()) WHERE is_bot;
ALTER TABLE users
    DROP CONSTRAINT users_email_or_guest,
    ADD CONSTRAINT users_email_or_guest CHECK (email IS NOT NULL OR is_guest);
ALTER TABLE users DROP COLUMN is_bot;
