package auth

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
)

// Revocation of a person's session reaches its access tokens in two ways (docs/04 «Auth»):
//
//   - the Valkey marker auth:revoked:<sid> (afterRevoke) — instant, checked on every request;
//   - sessions.revoked_at in Postgres — the source of truth, checked at most once per
//     sessionRecheck per session and instance.
//
// The second bounds what a lost marker costs. A marker is lost when Valkey refuses the SET
// at the moment of the revocation (outage, budget exhausted); before, the tokens then lived
// until they expired — up to ACCESS_TOKEN_TTL, which is 24 h since 2026-09-29. Now they die
// within sessionRecheck. It also keeps REST working while Valkey reads fail: the DB answers
// instead (both unavailable → fail closed, 503).
const sessionRecheck = time.Minute

// liveSessions remembers sessions the DB confirmed as not revoked, until the recheck time.
// Session ids are globally unique, so one cache serves every Service of the process.
var liveSessions = &liveCache{until: map[uuid.UUID]time.Time{}}

// liveCacheMax bounds the cache; past it, expired entries are pruned on insert.
const liveCacheMax = 50_000

type liveCache struct {
	mu    sync.Mutex
	until map[uuid.UUID]time.Time
}

func (c *liveCache) fresh(sid uuid.UUID, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	u, ok := c.until[sid]
	return ok && now.Before(u)
}

func (c *liveCache) put(sid uuid.UUID, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.until) >= liveCacheMax {
		for k, u := range c.until {
			if !now.Before(u) {
				delete(c.until, k)
			}
		}
		if len(c.until) >= liveCacheMax {
			clear(c.until)
		}
	}
	c.until[sid] = now.Add(sessionRecheck)
}

func (c *liveCache) drop(sid uuid.UUID) {
	c.mu.Lock()
	delete(c.until, sid)
	c.mu.Unlock()
}

// checkSession rejects an access token whose session was revoked: a RevokedError
// (errors.Is ErrSessionRevoked) with the reason, or a
// dependency error when neither Valkey nor Postgres can tell (fail closed).
func (s *Service) checkSession(ctx context.Context, sid uuid.UUID) error {
	reason, revoked, rerr := s.revokedReason(ctx, sid)
	if rerr == nil && revoked {
		return &RevokedError{Reason: reason}
	}
	now := s.now()
	if rerr == nil && liveSessions.fresh(sid, now) {
		return nil
	}
	sess, err := s.db.Q.GetSession(ctx, sid)
	switch {
	case db.IsNotFound(err):
		return ErrSessionRevoked // deleted with its user
	case err != nil && rerr != nil:
		return rerr
	case err != nil:
		// Postgres blip: the marker (checked above) is authoritative for instant revocation.
		slog.WarnContext(ctx, "session recheck failed", "session_id", sid, "err", err)
		return nil
	case sess.RevokedAt != nil:
		liveSessions.drop(sid)
		return &RevokedError{Reason: deref(sess.RevokedReason)}
	}
	if rerr != nil {
		slog.WarnContext(ctx, "revocation marker unreadable, checked the session in the DB", "session_id", sid, "err", rerr)
	}
	liveSessions.put(sid, now)
	if now.Sub(sess.LastSeenAt) > touchEvery {
		// «Настройки → Сеансы» shows the last activity; refreshes alone are a day apart now.
		if err := s.db.Q.TouchSession(ctx, sid); err != nil {
			slog.WarnContext(ctx, "session touch failed", "session_id", sid, "err", err)
		}
	}
	return nil
}

// touchEvery is how stale sessions.last_seen_at may get before a request bumps it (the
// query repeats the bound, so racing instances write once).
const touchEvery = 5 * time.Minute

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
