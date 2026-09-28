-- Voice quality tiers (docs/02 «Битрейт», docs/09 #90): 8 | 16 | 32 | 64 kbps, shown as words.
-- 8 is new (the telephone tier); 24 and 48 stay valid for rows written before the tiers (the
-- client maps them to the nearest tier).

-- +goose Up
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_audio_bitrate_kbps_check,
    ADD CONSTRAINT workspaces_default_audio_bitrate_kbps_check CHECK (default_audio_bitrate_kbps IN (8, 16, 24, 32, 48, 64));
ALTER TABLE rooms DROP CONSTRAINT rooms_audio_bitrate_kbps_check,
    ADD CONSTRAINT rooms_audio_bitrate_kbps_check CHECK (audio_bitrate_kbps IN (8, 16, 24, 32, 48, 64));

-- +goose Down
UPDATE workspaces SET default_audio_bitrate_kbps = 16 WHERE default_audio_bitrate_kbps = 8;
UPDATE rooms SET audio_bitrate_kbps = 16 WHERE audio_bitrate_kbps = 8;
ALTER TABLE workspaces DROP CONSTRAINT workspaces_default_audio_bitrate_kbps_check,
    ADD CONSTRAINT workspaces_default_audio_bitrate_kbps_check CHECK (default_audio_bitrate_kbps IN (16, 24, 32, 48, 64));
ALTER TABLE rooms DROP CONSTRAINT rooms_audio_bitrate_kbps_check,
    ADD CONSTRAINT rooms_audio_bitrate_kbps_check CHECK (audio_bitrate_kbps IN (16, 24, 32, 48, 64));
