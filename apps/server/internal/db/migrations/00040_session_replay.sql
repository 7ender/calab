-- Refresh-token replay without a time window (docs/04 «Auth», docs/09 #123). The previous
-- refresh token of a session gets the same new pair again for as long as the new token has
-- not been used; the first use (a refresh with it, or a request with an access token minted
-- for it) ends that. The sealed new secret moves from a 60 s Valkey entry into the row.
--
-- refresh_gen      generation of the current refresh secret (+1 per rotation); access JWTs
--                  carry it (claim "rg") so their first use is attributed to it.
-- refresh_used_at  first use of the current generation; NULL = unused (e.g. a lost answer).
-- replay_seal      the current secret sealed (AES-GCM) under a key derived from the previous
--                  secret: only a holder of the previous token can open it.
-- revoked_reason   why the session ended (REUSE, LOGOUT, LOGOUT_ALL, OTHER_DEVICE,
--                  PASSWORD_CHANGED, ACCOUNT_DISABLED, GUEST_EXPIRED); NULL before 00040.

-- +goose Up
ALTER TABLE sessions
    ADD COLUMN refresh_gen     bigint NOT NULL DEFAULT 1,
    ADD COLUMN refresh_used_at timestamptz,
    ADD COLUMN replay_seal     bytea,
    ADD COLUMN revoked_reason  text;

-- Rotations older than the 0.8.0 grace window (60 s) count as used, as 0.8.0 treated them: a
-- previous token presented now is reuse, not an endless 409 (no seal to replay from).
UPDATE sessions SET refresh_used_at = rotated_at
WHERE rotated_at IS NOT NULL AND rotated_at < now() - interval '60 seconds';

-- +goose Down
ALTER TABLE sessions
    DROP COLUMN refresh_gen,
    DROP COLUMN refresh_used_at,
    DROP COLUMN replay_seal,
    DROP COLUMN revoked_reason;
