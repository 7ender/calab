package auth

import (
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/identitypolicy"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestLiveCacheSessionDeadline(t *testing.T) {
	now := time.Now()
	c := &liveCache{until: map[uuid.UUID]time.Time{}}
	row := sqlc.Session{ID: uuid.New(), ExpiresAt: now.Add(time.Second)}
	c.put(row, now)
	if !c.fresh(row.ID, now) || c.fresh(row.ID, row.ExpiresAt) {
		t.Fatal("cache crossed authoritative session expiry")
	}
}

func TestLiveCachePrunesPrincipals(t *testing.T) {
	for _, expired := range []bool{false, true} {
		c := &liveCache{until: map[uuid.UUID]time.Time{}, principals: map[uuid.UUID]identitypolicy.Principal{}}
		now := time.Now()
		until := now.Add(time.Minute)
		if expired {
			until = now
		}
		old := uuid.New()
		for i := 0; i < liveCacheMax; i++ {
			id := uuid.New()
			if i == 0 {
				id = old
			}
			c.until[id] = until
			c.principals[id] = identitypolicy.Principal{}
		}
		row := sqlc.Session{ID: uuid.New(), ExpiresAt: now.Add(time.Hour)}
		c.put(row, now)
		if len(c.until) != 1 || len(c.principals) != 1 {
			t.Fatalf("expired=%v unbounded maps: %d/%d", expired, len(c.until), len(c.principals))
		}
		if _, exists := c.principals[old]; exists {
			t.Fatal("orphan principal survived pruning")
		}
	}
}
