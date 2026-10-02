package identitypolicy

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Delivery decides whether workspace content may leave Calab for a user outside any request
// (CalDAV push, meeting mail). There is no caller session to gate, so it never grants more
// than the user's own sessions could read: errors and unknown state deny.
type Delivery struct {
	Loader *SQLLoader
	Now    func() time.Time
}

func (d *Delivery) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d *Delivery) queries() (*sqlc.Queries, error) {
	if d == nil || d.Loader == nil || d.Loader.Q == nil {
		return nil, errors.New("identity database is unavailable")
	}
	return d.Loader.Q, nil
}

// Mode returns the workspace's durable policy mode. A missing row is the migration's explicit
// off default; an unknown mode is an error.
func (d *Delivery) Mode(ctx context.Context, ws uuid.UUID) (Mode, error) {
	q, err := d.queries()
	if err != nil {
		return "", err
	}
	p, err := q.GetIdentityPolicy(ctx, ws)
	if errors.Is(err, pgx.ErrNoRows) {
		return Off, nil
	}
	if err != nil {
		return "", err
	}
	switch m := Mode(p.Mode); m {
	case Off, Optional, Enforced:
		return m, nil
	default:
		return "", fmt.Errorf("unknown identity policy mode %q", p.Mode)
	}
}

// Check allows delivery of workspace ws content to user.
//
// Off/optional: the member must still stand in the workspace — not disabled, a guest or bot,
// banned or identity-suspended, and a directory-managed member needs an active object of a
// complete sync within the staleness bound and a live directory_sync entitlement (the
// membership and directory gates of Evaluate).
//
// Enforced (also when the entitlement lapsed): one of the user's live sessions must pass
// Evaluate(WorkspaceRead) for ws, i.e. hold a current SSO assurance with matching versions.
// A local password session alone, a recovery session or a scoped session of another workspace
// never qualifies.
func (d *Delivery) Check(ctx context.Context, user, ws uuid.UUID) (Decision, error) {
	q, err := d.queries()
	if err != nil {
		return deny(StateUnavailable), err
	}
	mode, err := d.Mode(ctx, ws)
	if err != nil {
		return deny(StateUnavailable), err
	}
	now := d.now()
	if mode != Enforced {
		m, err := q.GetIdentityMemberEligibility(ctx, sqlc.GetIdentityMemberEligibilityParams{WorkspaceID: ws, UserID: user})
		if errors.Is(err, pgx.ErrNoRows) {
			return deny(MembershipRequired), nil
		}
		if err != nil {
			return deny(StateUnavailable), err
		}
		switch {
		case m.UserDenied:
			return deny(InvalidSession), nil
		case !m.Member:
			return deny(MembershipRequired), nil
		case m.Suspended:
			return deny(MembershipSuspended), nil
		case m.DirectoryRequired && (!m.DirectoryActive || !now.Before(m.DirectoryValidUntil)):
			return deny(DirectoryStale), nil
		}
		until := now.Add(ReadLeaseTTL)
		if m.DirectoryRequired {
			// As Evaluate: a directory-managed member needs a live directory_sync entitlement,
			// not only a fresh scan (a revoked grant stops scans but not staleness for 1 h).
			g, err := d.Loader.LoadGrant(ctx, now, ws, DirectorySync)
			if err != nil {
				return deny(StateUnavailable), err
			}
			e := RequireEntitlement(now, ws, g, DirectorySync)
			if !e.Allowed {
				return e, nil
			}
			until = minimum(until, minimum(e.ValidUntil, m.DirectoryValidUntil))
		}
		return Decision{Allowed: true, Reason: Allowed, ValidUntil: until, Versions: Versions{Access: m.AccessVersion}}, nil
	}
	sessions, err := q.ListActiveSessions(ctx, user)
	if err != nil {
		return deny(StateUnavailable), err
	}
	last := deny(SSORequired)
	for _, s := range sessions {
		state, err := d.Loader.LoadIdentityState(ctx, s.ID, user, ws)
		if err != nil {
			return deny(StateUnavailable), err
		}
		if dec := Evaluate(now, state, WorkspaceRead); dec.Allowed {
			return dec, nil
		} else if dec.Reason != InvalidSession && dec.Reason != ScopeDenied {
			last = dec
		}
	}
	return last, nil
}
