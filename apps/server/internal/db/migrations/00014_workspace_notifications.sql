-- Notification levels per workspace (docs/09 item 22, docs/05 «Уведомления»): a workspace
-- level (default MENTIONS) that rooms left at the new room default INHERIT follow.
--
-- Existing users: a room without a stored row used to mean ALL; it now means INHERIT, i.e.
-- «Только упоминания» until the user raises the workspace or the room. Rows stored with
-- level 'all' only existed to carry a temporary mute (ALL without a mute was a deleted row),
-- so they never were an explicit choice either: they become 'inherit' and keep their mute.
-- Explicit MENTIONS / NONE rows stay as they are.

-- +goose Up
ALTER TABLE room_notification_settings DROP CONSTRAINT room_notification_settings_level_check;
ALTER TABLE room_notification_settings
    ADD CONSTRAINT room_notification_settings_level_check CHECK (level IN ('all', 'mentions', 'none', 'inherit'));
UPDATE room_notification_settings SET level = 'inherit' WHERE level = 'all';
-- An 'inherit' row without a mute is the default: stored as no row.
DELETE FROM room_notification_settings WHERE level = 'inherit' AND muted_until IS NULL;

CREATE TABLE workspace_notification_settings (
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    level        text NOT NULL CHECK (level IN ('all', 'mentions', 'none')),
    muted_until  timestamptz,
    PRIMARY KEY (user_id, workspace_id)
);
-- ON DELETE CASCADE from workspaces.id needs its own index.
CREATE INDEX workspace_notification_settings_workspace_id_idx ON workspace_notification_settings (workspace_id);

-- +goose Down
DROP TABLE workspace_notification_settings;
UPDATE room_notification_settings SET level = 'all' WHERE level = 'inherit';
ALTER TABLE room_notification_settings DROP CONSTRAINT room_notification_settings_level_check;
ALTER TABLE room_notification_settings
    ADD CONSTRAINT room_notification_settings_level_check CHECK (level IN ('all', 'mentions', 'none'));
