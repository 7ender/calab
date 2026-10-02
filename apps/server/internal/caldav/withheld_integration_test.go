//go:build integration

package caldav

import (
	"context"
	"crypto/x509"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/caldav/caldavtest"
	"github.com/calaba/calaba/server/internal/calendar"
	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/calaba/calaba/server/internal/redisx"
)

func TestMain(m *testing.M) {
	redisx.SetKeyPrefix("test-caldav-" + uuid.NewString()[:8] + ":")
	os.Exit(dbtest.Run(m))
}

// switchGate is the identity policy of the test: delivery allowed or withheld.
type switchGate struct{ allow atomic.Bool }

func (g *switchGate) Mode(context.Context, uuid.UUID) (identitypolicy.Mode, error) {
	return identitypolicy.Enforced, nil
}
func (g *switchGate) Check(context.Context, uuid.UUID, uuid.UUID) (identitypolicy.Decision, error) {
	if g.allow.Load() {
		return identitypolicy.Decision{Allowed: true, Reason: identitypolicy.Allowed}, nil
	}
	return identitypolicy.Decision{Reason: identitypolicy.SSORequired}, nil
}

// A change withheld by the identity policy withdraws the copy already in the external
// calendar; when the policy lets the meeting out again the push catches up with the current
// version — both for a change filtered at enqueue and for a push withheld at delivery.
func TestWithheldPushWithdrawsAndCatchesUp(t *testing.T) {
	ctx := context.Background()
	d := dbtest.Connect(t)
	redisURL := os.Getenv("TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("TEST_REDIS_URL required")
	}
	rc, err := redisx.Connect(ctx, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	fake := caldavtest.New("anna", "app-pass")
	t.Cleanup(fake.Close)
	pool := x509.NewCertPool()
	pool.AddCert(fake.Certificate())

	gate := &switchGate{}
	gate.allow.Store(true)
	now := time.Now()
	clock := func() time.Time { return now }
	cal := calendar.New(calendar.Config{PublicURL: "https://app.example.test", Secret: []byte("caldav-fixture")}, d, nil, nil, nil, nil)
	cal.Identity, cal.Now = gate, clock
	s := New(d, rc, cal, []byte("caldav-fixture"), Options{AllowAddr: func(netip.Addr) bool { return true }, RootCAs: pool}, nil, nil)
	s.Now = clock

	user, ws, event := uuid.New(), uuid.New(), uuid.New()
	start := now.Add(48 * time.Hour).Truncate(time.Hour)
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Anna')`, []any{user, user.String() + "@caldav.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'CalDAV',$3)`, []any{ws, "cd-" + ws.String()[:12], user}},
		{`INSERT INTO workspace_members(workspace_id,user_id,role)VALUES($1,$2,'owner')`, []any{ws, user}},
		{`INSERT INTO events(id,workspace_id,title,starts_at,ends_at,tz,organizer_id)VALUES($1,$2,'Plan v1',$3,$4,'UTC',$5)`, []any{event, ws, start, start.Add(time.Hour), user}},
	} {
		if _, err = d.Pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user)
	})
	secret, err := s.seal(user, "app-pass")
	if err != nil {
		t.Fatal(err)
	}
	href := fake.URL + fake.Calendar()
	if _, err = d.Q.UpsertCalDavAccount(ctx, sqlc.UpsertCalDavAccountParams{UserID: user, Url: fake.URL + "/", Username: "anna", SecretEnc: secret, Calendars: []byte("[]"), CalendarHref: &href, Push: true}); err != nil {
		t.Fatal(err)
	}
	object := func() string { o, _ := fake.Object(fake.Calendar() + event.String() + ".ics"); return o }
	rename := func(title string) {
		t.Helper()
		if _, err := d.Pool.Exec(ctx, `UPDATE events SET title=$2 WHERE id=$1`, event, title); err != nil {
			t.Fatal(err)
		}
	}
	work := func() {
		t.Helper()
		if _, err := s.ProcessPushes(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ProcessWithheld(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ProcessPushes(ctx); err != nil {
			t.Fatal(err)
		}
	}
	queued := func() int {
		var n int
		if err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM caldav_pushes WHERE user_id=$1`, user).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	s.EventChanged(ctx, event, []uuid.UUID{user})
	work()
	if !strings.Contains(object(), "SUMMARY:Plan v1") {
		t.Fatalf("allowed push: %q", object())
	}

	// Withheld at enqueue: nothing queued, the stale copy is withdrawn.
	gate.allow.Store(false)
	rename("Plan v2")
	s.EventChanged(ctx, event, []uuid.UUID{user})
	if queued() != 0 {
		t.Fatal("withheld change queued")
	}
	work()
	if object() != "" {
		t.Fatalf("withheld meeting left in the external calendar: %q", object())
	}
	deletes := func() int {
		n := 0
		for _, r := range fake.Requests() {
			if r.Method == "DELETE" {
				n++
			}
		}
		return n
	}
	// The recheck before the policy changes deletes nothing again and puts nothing.
	before := deletes()
	now = now.Add(withheldRecheck + time.Second)
	work()
	if deletes() != before || object() != "" {
		t.Fatal("recheck repeated the withdrawal or leaked the meeting")
	}

	// Assurance returns: the catch-up puts the current version without a new change.
	gate.allow.Store(true)
	now = now.Add(withheldRecheck + time.Second)
	work()
	if !strings.Contains(object(), "SUMMARY:Plan v2") {
		t.Fatalf("no catch-up after the policy allowed the meeting again: %q", object())
	}
	if n, err := rc.Do(ctx, rc.B().Zcard().Key(redisx.Key(withheldKey)).Build()).AsInt64(); err != nil || n != 0 {
		t.Fatalf("withheld entry kept after the catch-up: %d %v", n, err)
	}

	// Withheld at delivery: queued while allowed, delivered after the policy changed.
	rename("Plan v3")
	s.EventChanged(ctx, event, []uuid.UUID{user})
	gate.allow.Store(false)
	work()
	if object() != "" || queued() != 0 {
		t.Fatalf("push withheld at delivery left the copy: %q", object())
	}
	gate.allow.Store(true)
	now = now.Add(withheldRecheck + time.Second)
	work()
	if !strings.Contains(object(), "SUMMARY:Plan v3") {
		t.Fatalf("no catch-up of a push withheld at delivery: %q", object())
	}
}
