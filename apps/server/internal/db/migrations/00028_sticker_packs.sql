-- Sticker packs (ADR-0030, docs/09 item 58). A pack belongs to a workspace; a sticker is a
-- WebP file of that workspace (files row, counted in its storage quota) with an emoji for
-- search. A pack or sticker that messages still show is soft-deleted (deleted_at): it leaves
-- pickers and lists but stays visible in the history; an unreferenced sticker is deleted and
-- its file goes with the orphan cleanup. user_sticker_packs = the packs a user installed, in
-- their order. messages.sticker_id marks a sticker message (empty content, no attachments).

-- +goose Up
CREATE TABLE sticker_packs (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    short_name       text NOT NULL CHECK (short_name ~ '^[a-z0-9_]{1,32}$'),
    cover_sticker_id uuid,
    created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    deleted_at       timestamptz
);
CREATE UNIQUE INDEX sticker_packs_short_name_key ON sticker_packs (workspace_id, short_name) WHERE deleted_at IS NULL;

CREATE TABLE stickers (
    id         uuid PRIMARY KEY DEFAULT uuidv7(),
    pack_id    uuid NOT NULL REFERENCES sticker_packs (id) ON DELETE CASCADE,
    file_id    uuid NOT NULL UNIQUE REFERENCES files (id) ON DELETE CASCADE,
    emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
    position   integer NOT NULL,
    width      integer NOT NULL CHECK (width BETWEEN 1 AND 512),
    height     integer NOT NULL CHECK (height BETWEEN 1 AND 512),
    animated   boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);
CREATE INDEX stickers_pack_id_idx ON stickers (pack_id, position) WHERE deleted_at IS NULL;

ALTER TABLE sticker_packs ADD CONSTRAINT sticker_packs_cover_fkey
    FOREIGN KEY (cover_sticker_id) REFERENCES stickers (id) ON DELETE SET NULL;

CREATE TABLE user_sticker_packs (
    user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    pack_id  uuid NOT NULL REFERENCES sticker_packs (id) ON DELETE CASCADE,
    position integer NOT NULL,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, pack_id)
);
CREATE INDEX user_sticker_packs_pack_id_idx ON user_sticker_packs (pack_id);

ALTER TABLE messages ADD COLUMN sticker_id uuid REFERENCES stickers (id) ON DELETE SET NULL;
-- Deleting a sticker checks whether messages still show it.
CREATE INDEX messages_sticker_id_idx ON messages (sticker_id) WHERE sticker_id IS NOT NULL;

-- +goose Down
DROP INDEX messages_sticker_id_idx;
ALTER TABLE messages DROP COLUMN sticker_id;
DROP TABLE user_sticker_packs;
ALTER TABLE sticker_packs DROP CONSTRAINT sticker_packs_cover_fkey;
DROP TABLE stickers;
DROP TABLE sticker_packs;
