-- Private notes about other users (docs/09 item 20: "Note (only visible to you)"). One note
-- per (author, subject); only the author ever reads or writes it. New table, no rewrite.

-- +goose Up
CREATE TABLE user_notes (
    author_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    subject_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    text       text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (author_id, subject_id)
);
-- ON DELETE CASCADE from users.id (subject side) needs its own index.
CREATE INDEX user_notes_subject_id_idx ON user_notes (subject_id);

-- +goose Down
DROP TABLE user_notes;
