//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"testing"

	"github.com/jackc/pgx/v5"
)

// TestMigration30MessagesAutovacuum: 00030 only sets the insert-autovacuum storage parameters of
// messages (docs/18 step 5) and its Down resets them.
func TestMigration30MessagesAutovacuum(t *testing.T) {
	ctx := context.Background()
	adminURL := envOr("TEST_PG_URL", envOr("TEST_DATABASE_URL", "postgres://calaba:calaba@localhost:55432/calaba"))
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("postgres unavailable: %v", err)
	}
	defer func() { _ = admin.Close(ctx) }()
	var b [4]byte
	_, _ = rand.Read(b[:])
	name := "calaba_mig_" + hex.EncodeToString(b[:])
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	u, _ := url.Parse(adminURL)
	u.Path = "/" + name
	d, err := Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()

	opts := func() string {
		t.Helper()
		var s *string
		if err := d.Pool.QueryRow(ctx, `SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = 'messages'::regclass`).Scan(&s); err != nil {
			t.Fatal(err)
		}
		if s == nil {
			return ""
		}
		return *s
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if got, want := opts(), "autovacuum_vacuum_insert_scale_factor=0.05,autovacuum_vacuum_insert_threshold=1000"; got != want {
		t.Fatalf("reloptions after up: %q, want %q", got, want)
	}
	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 29); err != nil {
		t.Fatalf("down to 29: %v", err)
	}
	if got := opts(); got != "" {
		t.Fatalf("reloptions after down: %q", got)
	}
}
