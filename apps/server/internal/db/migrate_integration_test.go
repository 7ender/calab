//go:build integration

package db

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// TestMigrations15to17RoundTrip: a database at 00014 (the stand before ADR-0023/0024) with
// data migrates up to 00017, the three migrations go down cleanly (data of older tables
// kept) and up again.
func TestMigrations15to17RoundTrip(t *testing.T) {
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	if err := d.MigrateTo(ctx, 14); err != nil {
		t.Fatal(err)
	}
	user, ws := uuid.New(), uuid.New()
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, 'mig@example.com', 'm')`, user)
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-ws', 'W', $2)`, ws, user)

	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var verified *string
	if err := d.Pool.QueryRow(ctx, `SELECT email_verified_at::text FROM users WHERE id = $1`, user).Scan(&verified); err != nil || verified != nil {
		t.Fatalf("existing user after 00015: verified %v, err %v (no grandfathering)", verified, err)
	}
	inv := uuid.New()
	exec(`INSERT INTO workspace_invites (id, workspace_id, code, created_by, max_uses) VALUES ($1, $2, 'MIGCODE001', $3, 1)`, inv, ws, user)
	exec(`INSERT INTO email_invites (workspace_id, email, invited_by, invite_id, expires_at) VALUES ($1, 'x@example.com', $2, $3, now() + interval '7 days')`, ws, user, inv)
	exec(`INSERT INTO workspace_plans (workspace_id, plan, limits) VALUES ($1, 'custom', '{"room_members": 3}')`, ws)
	exec(`INSERT INTO workspace_plan_log (workspace_id, actor_id, plan, limits) VALUES ($1, $2, 'custom', '{}')`, ws, user)
	exec(`INSERT INTO email_codes (user_id, purpose, code_hash, expires_at) VALUES ($1, 'verify', 'h', now())`, user)
	exec(`INSERT INTO mail_outbox (to_addr, template, locale, expires_at) VALUES ('x@example.com', 'verify_code', 'en', now())`)

	p, err := newProvider(d)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.DownTo(ctx, 14); err != nil {
		t.Fatalf("down to 14: %v", err)
	}
	if v, err := p.GetDBVersion(ctx); err != nil || v != 14 {
		t.Fatalf("version after down: %d %v", v, err)
	}
	var n int
	if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM users u JOIN workspaces w ON w.owner_id = u.id WHERE u.id = $1`, user).Scan(&n); err != nil || n != 1 {
		t.Fatalf("data of older tables lost: %d %v", n, err)
	}
	if err := d.Migrate(ctx); err != nil {
		t.Fatalf("up again: %v", err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
