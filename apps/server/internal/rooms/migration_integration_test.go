//go:build integration

package rooms_test

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db"
)

// TestMigrationFlatRoomOrder runs 00012 on a fixture at version 11: default-named categories
// created with the workspace are dissolved (rooms keep their visible order at the top level),
// user categories stay and get contiguous positions with text rooms before voice ones.
func TestMigrationFlatRoomOrder(t *testing.T) {
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
	if err := d.MigrateTo(ctx, 11); err != nil {
		t.Fatal(err)
	}

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}
	owner := uuid.New()
	exec(`INSERT INTO users (id, email, display_name) VALUES ($1, 'o@example.com', 'o')`, owner)
	ws := uuid.New()
	exec(`INSERT INTO workspaces (id, slug, name, owner_id, created_at) VALUES ($1, 'mig-ws', 'W', $2, now() - interval '1 day')`, ws, owner)
	cat := func(name, created string, pos int) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO room_categories (id, workspace_id, name, position, created_at) VALUES ($1, $2, $3, $4, now() - $5::interval)`, id, ws, name, pos, created)
		return id
	}
	// Created with the workspace, default names: dissolved.
	defText := cat("Текстовые комнаты", "1 day", 1)
	defVoice := cat("Voice rooms", "1 day", 2)
	// User categories: a custom name, and a default name created a day later (a user's choice).
	custom := cat("Разработка", "1 day", 0)
	lateDefault := cat("Голосовые комнаты", "1 hour", 3)

	room := func(name, typ string, pos int, category *uuid.UUID) uuid.UUID {
		id := uuid.New()
		exec(`INSERT INTO rooms (id, workspace_id, type, name, position, category_id) VALUES ($1, $2, $3, $4, $5, $6)`, id, ws, typ, name, pos, category)
		return id
	}
	// Top level: the voice room has the lower position but was shown after the text room.
	topVoice := room("lobby", "voice", 0, nil)
	topText := room("general", "text", 5, nil)
	// Dissolved categories: text category (position 1) before voice category (position 2).
	t2 := room("random", "text", 3, &defText)
	t1 := room("news", "text", 3, &defText) // same position: by name
	v1 := room("call", "voice", 1, &defVoice)
	// User category: voice first by position, text first by the old rule.
	cv := room("standup", "voice", 0, &custom)
	ct := room("code", "text", 9, &custom)
	lv := room("music", "voice", 7, &lateDefault)

	if err := d.MigrateTo(ctx, 12); err != nil {
		t.Fatal(err)
	}

	type placement struct {
		pos int32
		cat *uuid.UUID
	}
	got := map[uuid.UUID]placement{}
	rows, err := d.Pool.Query(ctx, `SELECT id, position, category_id FROM rooms WHERE workspace_id = $1`, ws)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id uuid.UUID
		var p placement
		if err := rows.Scan(&id, &p.pos, &p.cat); err != nil {
			t.Fatal(err)
		}
		got[id] = p
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []struct {
		id  uuid.UUID
		pos int32
		cat *uuid.UUID
		n   string
	}{
		{topText, 0, nil, "general"}, {topVoice, 1, nil, "lobby"},
		{t1, 2, nil, "news"}, {t2, 3, nil, "random"}, {v1, 4, nil, "call"},
		{ct, 0, &custom, "code"}, {cv, 1, &custom, "standup"},
		{lv, 0, &lateDefault, "music"},
	}
	for _, w := range want {
		g := got[w.id]
		sameCat := (g.cat == nil) == (w.cat == nil) && (g.cat == nil || *g.cat == *w.cat)
		if g.pos != w.pos || !sameCat {
			t.Errorf("%s: position %d category %v, want %d %v", w.n, g.pos, g.cat, w.pos, w.cat)
		}
	}
	var left []string
	crows, err := d.Pool.Query(ctx, `SELECT name FROM room_categories WHERE workspace_id = $1 ORDER BY position`, ws)
	if err != nil {
		t.Fatal(err)
	}
	for crows.Next() {
		var n string
		if err := crows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		left = append(left, n)
	}
	if len(left) != 2 || left[0] != "Разработка" || left[1] != "Голосовые комнаты" {
		t.Fatalf("categories left: %v", left)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
