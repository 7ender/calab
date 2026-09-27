-- Voice messages (docs/09 #43): an Ogg/Opus attachment recorded in the app carries its
-- duration and a waveform (≤ 100 bars 0..255, computed by the client while recording).
-- Both NULL for any other file.

-- +goose Up
ALTER TABLE files
    ADD COLUMN voice_duration_ms integer
        CHECK (voice_duration_ms IS NULL OR voice_duration_ms BETWEEN 1 AND 300000),
    ADD COLUMN voice_waveform bytea
        CHECK (voice_waveform IS NULL OR octet_length(voice_waveform) <= 100);

-- +goose Down
ALTER TABLE files DROP COLUMN voice_waveform, DROP COLUMN voice_duration_ms;
