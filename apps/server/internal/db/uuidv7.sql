-- public.uuidv7() for PostgreSQL < 18 (ADR-0037); PG 18 has it built in (pg_catalog.uuidv7()).
-- The same layout as PG 18 (RFC 9562, method 3): 48-bit Unix ms, version 7, a 12-bit
-- sub-millisecond fraction in rand_a, the variant and 62 random bits. Like PG 18, the ids of one
-- session are strictly increasing: a call within the same 1/4096 ms, or after the clock stepped
-- back, takes the previous value plus one step (kept in a session setting; a rolled-back
-- transaction also rolls it back, together with the ids it generated).
-- PARALLEL UNSAFE: set_config() is not allowed in parallel workers.
CREATE OR REPLACE FUNCTION public.uuidv7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE
AS $$
DECLARE
    us   bigint := (extract(epoch FROM clock_timestamp()) * 1000000)::bigint;
    -- tick = Unix ms << 12 | the fraction of the ms in 1/4096 (clock_timestamp() has µs)
    tick bigint := ((us / 1000) << 12) | ((us % 1000) * 4096 / 1000);
    prev bigint := nullif(current_setting('calaba.uuidv7_tick', true), '')::bigint;
BEGIN
    IF tick <= prev THEN
        tick := prev + 1;
    END IF;
    PERFORM set_config('calaba.uuidv7_tick', tick::text, false);
    -- Bytes 0-5: ms; 6-7: version 7 and the fraction; 8-15: gen_random_uuid() bytes (random,
    -- with the variant bits 10 already set).
    RETURN encode(overlay(uuid_send(gen_random_uuid())
        PLACING int8send(((tick >> 12) << 16) | x'7000'::bigint | (tick & 4095)) FROM 1 FOR 8), 'hex')::uuid;
END
$$;
