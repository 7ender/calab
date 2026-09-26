//go:build integration

package app_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
)

// revokeProbe records whether SessionRevoked could still reach Redis.
type revokeProbe struct {
	events.Nop
	mu   sync.Mutex
	live map[uuid.UUID]bool
}

func (p *revokeProbe) SessionRevoked(ctx context.Context, sid uuid.UUID) {
	dctx, done := events.Detached(ctx, time.Hour)
	defer done()
	p.mu.Lock()
	p.live[sid] = dctx.Err() == nil
	p.mu.Unlock()
}

// "Log out everywhere" at the end of a request whose shared post-commit budget is already
// used up: the revocation markers (which kill live access tokens) and the socket-close
// events still go out — revocation has its own budget.
func TestLogoutAllIgnoresExhaustedRequestBudget(t *testing.T) {
	ctx := context.Background()
	email := "revoke-" + uuid.NewString()[:8] + "@example.com"
	u, err := testDB.Q.CreateUser(ctx, sqlc.CreateUserParams{Email: &email, DisplayName: "revoke", Settings: []byte("{}")})
	if err != nil {
		t.Fatal(err)
	}
	var sids []uuid.UUID
	for range 3 {
		sess, err := testDB.Q.CreateSession(ctx, sqlc.CreateSessionParams{UserID: u.ID, RefreshTokenHash: []byte("x"), ExpiresAt: time.Now().Add(time.Hour)})
		if err != nil {
			t.Fatal(err)
		}
		sids = append(sids, sess.ID)
	}
	probe := &revokeProbe{live: map[uuid.UUID]bool{}}
	svc := auth.NewService(testCfg, testDB, testRedis, probe)

	spent := events.WithBudget(ctx, 0) // e.g. a slow Redis ate the request's 5 s already
	if err := svc.Logout(spent, auth.Identity{UserID: u.ID, SessionID: sids[0]}, true); err != nil {
		t.Fatal(err)
	}
	for _, sid := range sids {
		if revoked, err := svc.IsRevoked(ctx, sid); err != nil || !revoked {
			t.Fatalf("session %s: access tokens stay valid after logout-all (revoked=%v err=%v)", sid, revoked, err)
		}
		if !probe.live[sid] {
			t.Fatalf("session %s: SessionRevoked published with an exhausted budget", sid)
		}
	}
}
