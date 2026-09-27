-- RNNoise off by default (owner, 27.09: employees' machines are weak; Chromium's built-in
-- noiseSuppression stays on). Existing users are switched off once too — they never chose it,
-- the app turned it on for them; Settings → Voice re-enables it. New users start with it off
-- (pbconv.DefaultSettings). Rows without the field get it written, so the server no longer
-- treats a missing field as «on».

-- +goose Up
UPDATE users SET settings = settings || '{"noiseSuppression": false}'::jsonb;

-- +goose Down
-- Nothing to restore: the previous per-user values are not kept.
