-- messages is append-mostly: the default insert-triggered autovacuum (20 % of the table) lets the
-- visibility map lag far behind, and the index-only unread count (ListReadStates) then falls back
-- to heap fetches — 150 ms instead of 10.6 ms on 200k messages (docs/18 step 5). Vacuum after 5 %
-- (+1000) inserted rows instead. Storage parameters only: no rewrite, no lock beyond a brief
-- SHARE UPDATE EXCLUSIVE.

-- +goose Up
ALTER TABLE messages SET (autovacuum_vacuum_insert_scale_factor = 0.05, autovacuum_vacuum_insert_threshold = 1000);

-- +goose Down
ALTER TABLE messages RESET (autovacuum_vacuum_insert_scale_factor, autovacuum_vacuum_insert_threshold);
