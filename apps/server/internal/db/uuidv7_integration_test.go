//go:build integration

package db

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestUUIDv7Polyfill: public.uuidv7() (uuidv7.sql, ADR-0037) gives version 7 ids with the
// variant 10 and the current Unix ms, strictly increasing within a session (10 000 calls in one
// statement, then call by call across statements and a rolled-back transaction) and ordered by
// time across sessions. The function is created directly, so it is checked on PostgreSQL 18
// as well, where its ids must also read as v7 to uuid_extract_timestamp() and sort among the
// built-in's.
func TestUUIDv7Polyfill(t *testing.T) {
	ctx := context.Background()
	dbURL := newTestDatabase(t)
	conn := connect(t, dbURL)
	if _, err := conn.Exec(ctx, uuidv7SQL); err != nil {
		t.Fatal(err)
	}
	valid := func(u uuid.UUID) {
		t.Helper()
		if u.Version() != 7 || u.Variant() != uuid.RFC4122 {
			t.Fatalf("%s: version %d, variant %v", u, u.Version(), u.Variant())
		}
	}
	increasing := func(prev, u uuid.UUID) {
		t.Helper()
		if bytes.Compare(prev[:], u[:]) >= 0 {
			t.Fatalf("not increasing: %s then %s", prev, u)
		}
	}
	clock := func(c *pgx.Conn) time.Time {
		t.Helper()
		var ts time.Time
		if err := c.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&ts); err != nil {
			t.Fatal(err)
		}
		return ts
	}
	next := func(c *pgx.Conn, q string) uuid.UUID {
		t.Helper()
		var u uuid.UUID
		if err := c.QueryRow(ctx, q).Scan(&u); err != nil {
			t.Fatal(err)
		}
		valid(u)
		return u
	}

	const n = 10000
	before := clock(conn)
	rows, err := conn.Query(ctx, `SELECT i, public.uuidv7() FROM generate_series(1, $1) AS i`, n)
	if err != nil {
		t.Fatal(err)
	}
	ids := make([]uuid.UUID, n)
	for rows.Next() {
		var i int
		var u uuid.UUID
		if err := rows.Scan(&i, &u); err != nil {
			t.Fatal(err)
		}
		ids[i-1] = u
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	after := clock(conn)
	var prev uuid.UUID // Nil sorts first
	for k, u := range ids {
		valid(u)
		if ms := v7Millis(u); ms < before.UnixMilli() || ms > after.UnixMilli() {
			t.Fatalf("id %d: %d ms, the statement ran %d..%d", k, ms, before.UnixMilli(), after.UnixMilli())
		}
		increasing(prev, u)
		prev = u
	}

	for k := range 200 {
		if k == 100 {
			rollbackOne(t, conn)
		}
		u := next(conn, `SELECT public.uuidv7()`)
		increasing(prev, u)
		prev = u
	}

	// A session whose first call was rolled back (the setting reads '' afterwards, not NULL).
	other := connect(t, dbURL)
	rollbackOne(t, other)
	next(other, `SELECT public.uuidv7()`)

	var version int
	if err := conn.QueryRow(ctx, `SELECT current_setting('server_version_num')::int`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	gens := []string{`SELECT public.uuidv7()`}
	if version >= 180000 {
		gens = append(gens, `SELECT pg_catalog.uuidv7()`)
		t0 := clock(conn)
		var ts time.Time
		if err := conn.QueryRow(ctx, `SELECT uuid_extract_timestamp(public.uuidv7())`).Scan(&ts); err != nil {
			t.Fatal(err)
		}
		if t1 := clock(conn); ts.UnixMilli() < t0.UnixMilli() || ts.UnixMilli() > t1.UnixMilli() {
			t.Fatalf("uuid_extract_timestamp: %v, the call ran %v..%v", ts, t0, t1)
		}
	}
	// Across sessions (and, on 18, generators) only the clock orders the ids: taken 2 ms apart,
	// they sort in the order of the calls.
	sessions := []*pgx.Conn{conn, other}
	var seq []uuid.UUID
	for k := range 8 {
		time.Sleep(2 * time.Millisecond)
		seq = append(seq, next(sessions[k%2], gens[k%len(gens)]))
	}
	sorted := slices.SortedFunc(slices.Values(seq), func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
	if !slices.Equal(seq, sorted) {
		t.Fatalf("ids 2 ms apart do not sort by time:\n%v\n%v", seq, sorted)
	}
}

// TestEnsureUUIDv7: on a fresh database, replicas starting at once (Migrate → ensureUUIDv7)
// create public.uuidv7() exactly once on PostgreSQL < 18 (the others wait for the lock and find
// it) and nothing on 18, where uuidv7() resolves to the built-in; the migrations then run and
// the id DEFAULTs give v7 ids.
func TestEnsureUUIDv7(t *testing.T) {
	ctx := context.Background()
	dbURL := newTestDatabase(t)
	replicas := make([]*DB, 4)
	for i := range replicas {
		d, err := Connect(ctx, dbURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(d.Close)
		replicas[i] = d
	}
	created := make([]bool, len(replicas))
	errs := make([]error, len(replicas))
	var wg sync.WaitGroup
	for i, d := range replicas {
		wg.Go(func() { created[i], errs[i] = d.ensureUUIDv7(ctx) })
	}
	wg.Wait()
	creations := 0
	for i, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
		if created[i] {
			creations++
		}
	}

	d := replicas[0]
	var version, inPublic int
	var schema string
	if err := d.Pool.QueryRow(ctx, `SELECT current_setting('server_version_num')::int,
		(SELECT pronamespace::regnamespace::text FROM pg_proc WHERE oid = to_regprocedure('uuidv7()')),
		(SELECT count(*) FROM pg_proc WHERE proname = 'uuidv7' AND pronamespace = 'public'::regnamespace)`).
		Scan(&version, &schema, &inPublic); err != nil {
		t.Fatal(err)
	}
	wantSchema, wantInPublic := "public", 1
	if version >= 180000 {
		wantSchema, wantInPublic = "pg_catalog", 0
	}
	if schema != wantSchema || inPublic != wantInPublic || creations != wantInPublic {
		t.Fatalf("server %d: uuidv7() resolves to %s, %d in public, created %d times; want %s, %d, %d",
			version, schema, inPublic, creations, wantSchema, wantInPublic, wantInPublic)
	}

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var id uuid.UUID
	if err := d.Pool.QueryRow(ctx, `INSERT INTO users (email, display_name) VALUES ('v7@example.com', 'v7') RETURNING id`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if id.Version() != 7 || id.Variant() != uuid.RFC4122 {
		t.Fatalf("users.id DEFAULT: %s", id)
	}
}

// newTestDatabase creates an empty database, dropped when the test ends, and returns its URL.
func newTestDatabase(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	adminURL := envOr("TEST_PG_URL", envOr("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("postgres unavailable: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := "calaba_mig_" + hex.EncodeToString(b[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") })
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	return u.String()
}

func connect(t *testing.T, dbURL string) *pgx.Conn {
	t.Helper()
	c, err := pgx.Connect(context.Background(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close(context.Background()) })
	return c
}

// rollbackOne calls public.uuidv7() in a transaction that is rolled back.
func rollbackOne(t *testing.T, c *pgx.Conn) {
	t.Helper()
	ctx := context.Background()
	tx, err := c.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var u uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT public.uuidv7()`).Scan(&u); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
}

// v7Millis is the 48-bit Unix ms timestamp of a version 7 UUID.
func v7Millis(u uuid.UUID) int64 {
	var ms int64
	for _, b := range u[:6] {
		ms = ms<<8 | int64(b)
	}
	return ms
}
