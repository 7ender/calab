//go:build integration

package app_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/guests"
)

// hungPublisher behaves like events.Redis against a Redis that accepts commands and never
// answers: every publish waits until its (budget-bounded) context expires.
type hungPublisher struct{ calls atomic.Int32 }

func (p *hungPublisher) wait(ctx context.Context) {
	p.calls.Add(1)
	dctx, done := events.Detached(ctx, 3*time.Second)
	<-dctx.Done()
	done()
}

func (p *hungPublisher) Workspace(ctx context.Context, _ uuid.UUID, _ *v1.DispatchEvent) { p.wait(ctx) }
func (p *hungPublisher) User(ctx context.Context, _ uuid.UUID, _ *v1.DispatchEvent)      { p.wait(ctx) }
func (p *hungPublisher) Workspaces(ctx context.Context, _ []uuid.UUID, _ *v1.DispatchEvent) {
	p.wait(ctx)
}

func (p *hungPublisher) WorkspaceEvents(ctx context.Context, _ uuid.UUID, _ []*v1.DispatchEvent) {
	p.wait(ctx)
}
func (p *hungPublisher) SessionRevoked(ctx context.Context, _ uuid.UUID) { p.wait(ctx) }

// Guest cleanup with a hung event bus: a guest in many workspaces (one MEMBER_REMOVE each)
// plus a session revocation is removed within one pass budget, not 3 s per publish.
func TestGuestCleanupWithHungPublisherIsBounded(t *testing.T) {
	o := owner(t)
	ctx := context.Background()
	q := testDB.Q
	past := time.Now().Add(-time.Hour)
	g, err := q.CreateGuestUser(ctx, sqlc.CreateGuestUserParams{DisplayName: "hung guest", Settings: []byte("{}"), GuestExpiresAt: &past})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.CreateSession(ctx, sqlc.CreateSessionParams{UserID: g.ID, RefreshTokenHash: []byte("x"), ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	const n = 6 // unbounded: (6 MEMBER_REMOVE + 1 revoke) × 3 s = 21 s
	for range n {
		ws, err := q.CreateWorkspace(ctx, sqlc.CreateWorkspaceParams{
			Slug: "hung-" + uuid.NewString()[:8], Name: "hung", Visibility: "private", OwnerID: uuid.MustParse(o.id), StorageQuotaBytes: 1 << 20,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := q.AddMember(ctx, sqlc.AddMemberParams{WorkspaceID: ws.ID, UserID: g.ID, Role: "guest"}); err != nil {
			t.Fatal(err)
		}
	}

	pub := &hungPublisher{}
	authSvc := auth.NewService(testCfg, testDB, testRedis, pub)
	svc := guests.NewService(testDB, authSvc, pub, testStore, nil, nil)
	start := time.Now()
	if _, err := svc.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	// Session revocation has its own 3 s (auth.revokeBudget), outside the pass budget.
	if d, limit := time.Since(start), events.RequestBudget+3*time.Second+2*time.Second; d > limit {
		t.Fatalf("cleanup pass with a hung publisher took %v (limit %v)", d, limit)
	}
	if pub.calls.Load() < n+1 {
		t.Fatalf("publishes attempted: %d, want ≥ %d", pub.calls.Load(), n+1)
	}
	u, err := q.GetUser(ctx, g.ID)
	if err != nil || u.DisabledAt == nil {
		t.Fatalf("guest not removed: %v %v", err, u.DisabledAt)
	}
}
