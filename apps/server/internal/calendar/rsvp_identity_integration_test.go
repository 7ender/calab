//go:build integration

package calendar

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/db/dbtest"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/google/uuid"
)

func TestMain(m *testing.M) { os.Exit(dbtest.Run(m)) }

// A signed RSVP link mailed before the workspace turned enforced must not show the
// meeting: the anonymous page (GET) and answer (POST) get SSO_REQUIRED, no title/organizer.
func TestRSVPLinkHidesMeetingInEnforcedWorkspace(t *testing.T) {
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
	organizer, ws, event := uuid.New(), uuid.New(), uuid.New()
	email := "partner-" + uuid.NewString()[:8] + "@outside.test"
	start := time.Now().Add(24 * time.Hour).Truncate(time.Hour)
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,email,display_name)VALUES($1,$2,'Organizer Name')`, []any{organizer, organizer.String() + "@rsvp.test"}},
		{`INSERT INTO workspaces(id,slug,name,owner_id)VALUES($1,$2,'RSVP',$3)`, []any{ws, "rsvp-" + ws.String()[:12], organizer}},
		{`INSERT INTO events(id,workspace_id,title,starts_at,ends_at,tz,organizer_id)VALUES($1,$2,'Secret merger',$3,$4,'UTC',$5)`, []any{event, ws, start, start.Add(time.Hour), organizer}},
		{`INSERT INTO event_attendees(event_id,email,required,status)VALUES($1,$2,true,'pending')`, []any{event, email}},
	} {
		if _, err = d.Pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id=$1`, ws)
		_, _ = d.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, organizer)
	})
	s := New(Config{PublicURL: "https://app.example.test", Secret: []byte("rsvp-fixture")}, d, nil, nil, nil,
		redisx.NewRateLimiter(rc, "rl:test-event-rsvp:"+uuid.NewString()+":", 100, 100))
	token := signRSVP(s.key, rsvpClaims{Event: event, Status: StatusAccepted, Email: email, Exp: start.Add(48 * time.Hour)})
	mux := http.NewServeMux()
	s.Routes(mux, func(h http.Handler) http.Handler { return h })
	call := func(method string) *httptest.ResponseRecorder {
		t.Helper()
		var r *http.Request
		if method == http.MethodGet {
			r = httptest.NewRequestWithContext(ctx, method, "/api/event-rsvp?t="+url.QueryEscape(token), nil)
		} else {
			r = httptest.NewRequestWithContext(ctx, method, "/api/event-rsvp", strings.NewReader(`{"token":"`+token+`"}`))
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := call(http.MethodGet); w.Code != 200 || !strings.Contains(w.Body.String(), "Secret merger") {
		t.Fatalf("off: %d %s", w.Code, w.Body.String())
	}
	if _, err = d.Pool.Exec(ctx, `INSERT INTO workspace_identity_policies(workspace_id,mode)VALUES($1,'enforced')`, ws); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		w := call(method)
		body := w.Body.String()
		if w.Code != 403 || !strings.Contains(body, "SSO_REQUIRED") || strings.Contains(body, "Secret merger") || strings.Contains(body, "Organizer Name") {
			t.Fatalf("enforced %s: %d %s", method, w.Code, body)
		}
	}
	var status string
	if err = d.Pool.QueryRow(ctx, `SELECT status FROM event_attendees WHERE event_id=$1`, event).Scan(&status); err != nil || status != "pending" {
		t.Fatalf("enforced answer stored: %q %v", status, err)
	}
}
