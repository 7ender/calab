//go:build integration

package notifications_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db"
)

// TestMigrationWorkspaceLevels runs 00014 on a fixture at version 13: rooms without an
// explicit level become INHERIT (no row), a stored 'all' that only carried a mute becomes
// 'inherit' with the mute kept, explicit MENTIONS / NONE stay.
func TestMigrationWorkspaceLevels(t *testing.T) {
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
	d, err := db.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if err := d.MigrateTo(ctx, 13); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	user := uuid.New()
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, 'u@example.com', 'u')`, user)
	ws := uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id) VALUES ($1, 'mig-ws', 'W', $2)`, ws, user)
	room := func(n string) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO rooms (id, workspace_id, type, name, position) VALUES ($1, $2, 'text', $3, 0)`, id, ws, n)
		return id
	}
	plain, mutedAll, mentions, none := room("plain"), room("muted"), room("mentions"), room("none")
	until := time.Now().Add(time.Hour).Truncate(time.Second)
	exec(`INSERT INTO room_notification_settings (user_id, room_id, level, muted_until) VALUES ($1, $2, 'all', $3)`, user, mutedAll, until)
	exec(`INSERT INTO room_notification_settings (user_id, room_id, level) VALUES ($1, $2, 'mentions')`, user, mentions)
	exec(`INSERT INTO room_notification_settings (user_id, room_id, level) VALUES ($1, $2, 'none')`, user, none)

	if err := d.MigrateTo(ctx, 14); err != nil {
		t.Fatal(err)
	}
	levels := func() map[uuid.UUID]string {
		t.Helper()
		rows, err := d.Pool.Query(ctx, `SELECT room_id, level FROM room_notification_settings WHERE user_id = $1`, user)
		if err != nil {
			t.Fatal(err)
		}
		m := map[uuid.UUID]string{}
		for rows.Next() {
			var id uuid.UUID
			var l string
			if err := rows.Scan(&id, &l); err != nil {
				t.Fatal(err)
			}
			m[id] = l
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return m
	}
	got := levels()
	if len(got) != 3 || got[mutedAll] != "inherit" || got[mentions] != "mentions" || got[none] != "none" || got[plain] != "" {
		t.Fatalf("after up: %v", got)
	}
	var mu time.Time
	if err := d.Pool.QueryRow(ctx, `SELECT muted_until FROM room_notification_settings WHERE room_id = $1`, mutedAll).Scan(&mu); err != nil || !mu.Equal(until) {
		t.Fatalf("mute lost: %v %v", mu, err)
	}
	// The new table and the widened check are in place.
	exec(`INSERT INTO workspace_notification_settings (user_id, workspace_id, level) VALUES ($1, $2, 'all')`, user, ws)
	exec(`INSERT INTO room_notification_settings (user_id, room_id, level) VALUES ($1, $2, 'inherit')`, user, plain)
	if _, err := d.Pool.Exec(ctx, `INSERT INTO workspace_notification_settings (user_id, workspace_id, level) VALUES ($1, $2, 'inherit')
		ON CONFLICT (user_id, workspace_id) DO UPDATE SET level = EXCLUDED.level`, user, ws); err == nil {
		t.Fatal("workspace level 'inherit' accepted")
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
