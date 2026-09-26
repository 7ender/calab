-- P0.6 (docs/09 #48, #51): voice room status line and per-message embed suppression.
-- Both are metadata-only column additions (no table rewrite, no long lock).

-- +goose Up
ALTER TABLE rooms ADD COLUMN voice_status text CHECK (char_length(voice_status) BETWEEN 1 AND 60);
ALTER TABLE messages ADD COLUMN embeds_hidden boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE messages DROP COLUMN embeds_hidden;
ALTER TABLE rooms DROP COLUMN voice_status;
