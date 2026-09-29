//go:build integration

package app_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Access tokens live 24 h (config defaults, 2026-09-29), so revocation must never wait for
// expiry: every way a session ends kills its access token on REST (401) and closes its
// gateway socket (4010) at once (docs/04 «Auth»).
func TestRevocationIsInstantWithLongAccessTTL(t *testing.T) {
	if testCfg.AccessTokenTTL < 24*time.Hour {
		t.Fatalf("the harness must run with the long default access TTL, got %v", testCfg.AccessTokenTTL)
	}
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	logins := 0
	type device struct {
		*client
		refresh, session string
		gw               *gw
	}
	login := func(email, password string) *device {
		t.Helper()
		logins++
		c := &client{t: t, ip: fmt.Sprintf("10.64.%d.%d", logins/250, logins%250+1)}
		var l v1.LoginResponse
		c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: password, DeviceName: fmt.Sprintf("dev%d", logins)}, &l)
		c.token = l.GetTokens().GetAccessToken()
		g := dialGW(t)
		g.identify(c.token)
		return &device{client: c, refresh: l.GetTokens().GetRefreshToken(), session: l.GetTokens().GetSessionId(), gw: g}
	}
	// dead: REST 401 and the socket closed with 4010 within ~1 s of the revocation.
	dead := func(what string, d *device, since time.Time) {
		t.Helper()
		if st := d.gw.closeStatus(); st != 4010 {
			t.Fatalf("%s: socket close %d, want 4010", what, st)
		}
		if el := time.Since(since); el > 1500*time.Millisecond {
			t.Fatalf("%s: socket closed after %v, want ~1 s", what, el)
		}
		d.must(401, "GET", "/api/me", nil, nil)
	}
	alive := func(what string, d *device) {
		t.Helper()
		d.must(200, "GET", "/api/me", nil, nil)
		for deadline := time.Now().Add(300 * time.Millisecond); time.Now().Before(deadline); {
			if _, err := d.gw.read(time.Until(deadline)); err != nil && !errors.Is(err, errNoFrame) {
				t.Fatalf("%s: socket closed: %v", what, err)
			}
		}
	}

	// Logout (this device).
	u := register(t, code)
	a := login(u.email, "password123")
	b := login(u.email, "password123")
	start := time.Now()
	a.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{}, nil)
	dead("logout", a, start)
	alive("logout: other device", b)

	// Logout everywhere.
	c := login(u.email, "password123")
	start = time.Now()
	b.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{AllSessions: true}, nil)
	dead("logout everywhere: caller", b, start)
	dead("logout everywhere: other device", c, start)

	// Revoke one session in «Настройки → Сеансы».
	a, b = login(u.email, "password123"), login(u.email, "password123")
	start = time.Now()
	a.must(204, "DELETE", "/api/me/sessions/"+b.session, nil, nil)
	dead("session revoked from the list", b, start)
	alive("session list: the caller", a)

	// Password change: every other session.
	b = login(u.email, "password123")
	start = time.Now()
	a.must(204, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "password123", NewPassword: "newpassword1"}, nil)
	dead("password change: other device", b, start)
	alive("password change: the caller", a)

	// Refresh-token reuse: the session is revoked (auth.Service.Refresh).
	b = login(u.email, "newpassword1")
	var r v1.RefreshResponse
	b.must(200, "POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: b.refresh}, &r)
	(&client{t: t, ip: b.ip}).must(200, "POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: r.GetTokens().GetRefreshToken()}, nil)
	start = time.Now()
	if st := (&client{t: t, ip: b.ip}).do("POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: b.refresh}, nil); st != 401 {
		t.Fatalf("reused refresh token: %d, want 401", st)
	}
	dead("refresh reuse", b, start)

	// Account disabled (expired guest removed by the cleanup): all of its sessions.
	ctx := context.Background()
	future := time.Now().Add(time.Hour)
	g, err := testDB.Q.CreateGuestUser(ctx, sqlc.CreateGuestUserParams{DisplayName: "revoked guest", Settings: []byte("{}"), GuestExpiresAt: &future})
	if err != nil {
		t.Fatal(err)
	}
	sess, err := testDB.Q.CreateSession(ctx, sqlc.CreateSessionParams{UserID: g.ID, RefreshTokenHash: []byte("x"), ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	tok, _, err := testApp.Auth.Tokens().Issue(g.ID, sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	gd := &device{client: &client{t: t, token: tok}, gw: dialGW(t)}
	gd.gw.identify(tok)
	gd.must(200, "GET", "/api/me", nil, nil)
	if _, err := testDB.Pool.Exec(ctx, "UPDATE users SET guest_expires_at = now() - interval '1 minute' WHERE id = $1", g.ID); err != nil {
		t.Fatal(err)
	}
	start = time.Now()
	if _, err := testApp.Guests.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	dead("disabled account", gd, start)
}

// A revocation whose Valkey marker was lost (Valkey refused the SET at logout) is still
// caught: the DB recheck (auth/sessioncheck.go) rejects the token at the latest after a
// minute — here at once, since the token was never checked before.
func TestRevocationWithoutMarkerFallsBackToDB(t *testing.T) {
	o := owner(t)
	email := mustEmail(t, o)
	c := &client{t: t, ip: "10.65.0.1"}
	var l v1.LoginResponse
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123", DeviceName: "lost-marker"}, &l)
	c.token = l.GetTokens().GetAccessToken()
	if _, err := testDB.Q.RevokeSession(context.Background(), uuid.MustParse(l.GetTokens().GetSessionId())); err != nil {
		t.Fatal(err) // DB only: no marker, no socket event
	}
	c.must(401, "GET", "/api/me", nil, nil)
}

// Valkey unreachable: the marker cannot be read, the DB decides — live sessions keep
// working, revoked ones are refused. Fail closed only when Postgres cannot answer either.
func TestRevocationCheckWithValkeyDown(t *testing.T) {
	ctx := context.Background()
	dead, err := redisx.Connect(ctx, testRedisURL)
	if err != nil {
		t.Fatal(err)
	}
	dead.Close() // every command now fails
	svc := auth.NewService(testCfg, testDB, dead, nil)

	o := owner(t)
	uid := uuid.MustParse(o.id)
	mk := func() (uuid.UUID, string) {
		s, err := testDB.Q.CreateSession(ctx, sqlc.CreateSessionParams{UserID: uid, RefreshTokenHash: []byte("x"), ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		tok, _, err := svc.Tokens().Issue(uid, s.ID)
		if err != nil {
			t.Fatal(err)
		}
		return s.ID, tok
	}
	_, liveTok := mk()
	if _, err := svc.AuthenticateToken(ctx, liveTok); err != nil {
		t.Fatalf("live session with Valkey down: %v", err)
	}
	revokedID, revokedTok := mk()
	if _, err := testDB.Q.RevokeSession(ctx, revokedID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateToken(ctx, revokedTok); !errors.Is(err, auth.ErrSessionRevoked) {
		t.Fatalf("revoked session with Valkey down: %v, want ErrSessionRevoked", err)
	}
}

// «Настройки → Сеансы» shows the last activity: with day-long access tokens a refresh no
// longer bumps it often, so the session recheck does (at most every 5 minutes).
func TestSessionLastSeenBumpedByRequests(t *testing.T) {
	o := owner(t)
	c := &client{t: t, ip: "10.65.0.2"}
	var l v1.LoginResponse
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: mustEmail(t, o), Password: "password123", DeviceName: "last-seen"}, &l)
	c.token = l.GetTokens().GetAccessToken()
	sid := uuid.MustParse(l.GetTokens().GetSessionId())
	ctx := context.Background()
	if _, err := testDB.Pool.Exec(ctx, "UPDATE sessions SET last_seen_at = now() - interval '3 hours' WHERE id = $1", sid); err != nil {
		t.Fatal(err)
	}
	c.must(200, "GET", "/api/me", nil, nil)
	s, err := testDB.Q.GetSession(ctx, sid)
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(s.LastSeenAt) > time.Minute {
		t.Fatalf("last_seen_at not bumped: %v", s.LastSeenAt)
	}
}
