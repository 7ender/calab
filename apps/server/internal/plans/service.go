package plans

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/redisx"
)

// CacheTTL bounds how long an instance serves a plan it read: changes made on this instance
// invalidate at once, other instances hear about them over Redis (changedChannel); the TTL
// covers a lost notification.
const CacheTTL = 30 * time.Second

// changedChannel carries the ids of workspaces whose plan changed (all instances).
const changedChannel = "plans:changed"

// Info is the resolved plan of a workspace.
type Info struct {
	Plan       v1.Plan
	Limits     Limits // effective (free when expired)
	ValidUntil *time.Time
	Expired    bool
}

// Proto converts the plan to the wire message (Workspace.plan).
func (i Info) Proto() *v1.WorkspacePlan {
	p := &v1.WorkspacePlan{Plan: i.Plan, Limits: i.Limits.Proto(), Expired: i.Expired}
	if i.ValidUntil != nil {
		p.ValidUntil = timestamppb.New(*i.ValidUntil)
	}
	return p
}

type cached struct {
	info  Info
	until time.Time
}

// Service resolves workspace plans with a short in-memory cache.
type Service struct {
	load  func(ctx context.Context, wsID uuid.UUID) (*sqlc.WorkspacePlan, error) // nil row = none
	redis rueidis.Client                                                         // nil: no cross-instance invalidation
	free  Limits
	team  Limits
	now   func() time.Time

	mu    sync.Mutex
	cache map[uuid.UUID]cached
	gen   uint64 // bumped by every invalidation: a read that raced one is not cached
}

// New creates the service with the free / team limits (see Defaults).
func New(d *db.DB, r rueidis.Client, free, team Limits) *Service {
	load := func(ctx context.Context, wsID uuid.UUID) (*sqlc.WorkspacePlan, error) {
		row, err := d.Q.GetWorkspacePlan(ctx, wsID)
		if db.IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &row, nil
	}
	return &Service{load: load, redis: r, free: free, team: team, now: time.Now, cache: map[uuid.UUID]cached{}}
}

// Defaults parses PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS over the built-in defaults.
func Defaults(freeJSON, teamJSON string) (free, team Limits, err error) {
	if free, err = ParseLimits(freeJSON, DefaultFree); err != nil {
		return Limits{}, Limits{}, err
	}
	if team, err = ParseLimits(teamJSON, DefaultTeam); err != nil {
		return Limits{}, Limits{}, err
	}
	return free, team, nil
}

// SetDefaults replaces the free / team limits and drops the cache (tests).
func (s *Service) SetDefaults(free, team Limits) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.free, s.team = free, team
	s.cache = map[uuid.UUID]cached{}
	s.gen++
}

// PlanLimits returns the configured limits of a plan kind (FREE for unknown kinds).
func (s *Service) PlanLimits(p v1.Plan) Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p == v1.Plan_PLAN_TEAM {
		return s.team
	}
	return s.free
}

// Effective returns the effective limits of a workspace.
func (s *Service) Effective(ctx context.Context, wsID uuid.UUID) (Limits, error) {
	i, err := s.Info(ctx, wsID)
	return i.Limits, err
}

// Info returns the resolved plan of a workspace.
func (s *Service) Info(ctx context.Context, wsID uuid.UUID) (Info, error) {
	now := s.now()
	s.mu.Lock()
	c, ok := s.cache[wsID]
	gen := s.gen
	s.mu.Unlock()
	if ok && now.Before(c.until) {
		return c.info, nil
	}
	rp, err := s.load(ctx, wsID)
	if err != nil {
		return Info{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	info := s.resolveLocked(ctx, rp, now)
	until := now.Add(CacheTTL)
	if info.ValidUntil != nil && !info.Expired && info.ValidUntil.Before(until) {
		until = *info.ValidUntil // re-resolve the moment the plan expires
	}
	if s.gen == gen {
		s.cache[wsID] = cached{info: info, until: until}
	}
	return info, nil
}

// Resolve computes the plan of a stored row (nil = no row) at time now.
func (s *Service) Resolve(ctx context.Context, row *sqlc.WorkspacePlan, now time.Time) Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.resolveLocked(ctx, row, now)
}

func (s *Service) resolveLocked(ctx context.Context, row *sqlc.WorkspacePlan, now time.Time) Info {
	if row == nil {
		return Info{Plan: v1.Plan_PLAN_FREE, Limits: s.free}
	}
	info := Info{Plan: PlanFromDB(row.Plan), ValidUntil: row.ValidUntil}
	if row.ValidUntil != nil && !now.Before(*row.ValidUntil) {
		info.Expired, info.Limits = true, s.free
		return info
	}
	switch info.Plan {
	case v1.Plan_PLAN_TEAM:
		info.Limits = s.team
	case v1.Plan_PLAN_CUSTOM:
		l, err := ParseLimits(string(row.Limits), Limits{})
		if err != nil { // written by us, validated; fail safe to free if it is ever corrupt
			slog.WarnContext(ctx, "invalid custom plan limits, using free", "workspace", row.WorkspaceID, "err", err)
			l = s.free
		}
		info.Limits = l
	default:
		info.Limits = s.free
	}
	return info
}

// Fill sets ws.plan (a workspace of the caller's view). nil-safe: a nil service fills nothing.
func (s *Service) Fill(ctx context.Context, ws *v1.Workspace) error {
	if s == nil || ws == nil {
		return nil
	}
	id, err := uuid.Parse(ws.GetId())
	if err != nil {
		return nil
	}
	info, err := s.Info(ctx, id)
	if err != nil {
		return err
	}
	ws.Plan = info.Proto()
	return nil
}

// FillAll is Fill for a list.
func (s *Service) FillAll(ctx context.Context, wss []*v1.Workspace) error {
	for _, w := range wss {
		if err := s.Fill(ctx, w); err != nil {
			return err
		}
	}
	return nil
}

// Invalidate drops the cached plan of wsID here and on every other instance.
func (s *Service) Invalidate(ctx context.Context, wsID uuid.UUID) {
	s.drop(wsID)
	if s.redis == nil {
		return
	}
	if err := s.redis.Do(ctx, s.redis.B().Publish().Channel(redisx.Channel(changedChannel)).Message(wsID.String()).Build()).Error(); err != nil {
		slog.WarnContext(ctx, "publish plan change", "workspace", wsID, "err", err) // the TTL catches up
	}
}

func (s *Service) drop(wsID uuid.UUID) {
	s.mu.Lock()
	delete(s.cache, wsID)
	s.gen++
	s.mu.Unlock()
}

// Run listens for plan changes of other instances until ctx is done. After every
// (re)subscription the whole cache is dropped: notifications may have been missed.
func (s *Service) Run(ctx context.Context) {
	if s.redis == nil {
		return
	}
	for ctx.Err() == nil {
		s.mu.Lock()
		s.cache = map[uuid.UUID]cached{}
		s.gen++
		s.mu.Unlock()
		err := s.redis.Receive(ctx, s.redis.B().Subscribe().Channel(redisx.Channel(changedChannel)).Build(), func(m rueidis.PubSubMessage) {
			if id, err := uuid.Parse(m.Message); err == nil {
				s.drop(id)
			}
		})
		if ctx.Err() != nil {
			return
		}
		slog.WarnContext(ctx, "plan change subscription lost, retrying", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

var planToDB = map[v1.Plan]string{v1.Plan_PLAN_FREE: "free", v1.Plan_PLAN_TEAM: "team", v1.Plan_PLAN_CUSTOM: "custom"}

// PlanToDB maps the enum to the DB text; ok=false for UNSPECIFIED / unknown.
func PlanToDB(p v1.Plan) (string, bool) {
	s, ok := planToDB[p]
	return s, ok
}

// PlanFromDB maps DB text to the enum (FREE for unknown text).
func PlanFromDB(s string) v1.Plan {
	for k, v := range planToDB {
		if v == s {
			return k
		}
	}
	return v1.Plan_PLAN_FREE
}
