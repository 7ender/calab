package gateway

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Presence keys (docs/05):
//
//	presence:<user_id>       hash gateway_session_id -> status (int), each field with its own
//	                         TTL (HEXPIRE, Redis ≥ 7.4) of 2×heartbeat, renewed by heartbeats
//	presence:last:<user_id>  last published aggregate (to publish only on change)
//	presence:seen:<user_id>  unix ms of the last activity of a visible session
//	presence:users           zset user_id -> last touch (for the offline sweeper)

// Session statuses combine by priority: manual statuses (dnd, invisible) always win over
// automatic ones, so an AFK "idle" from one device never overrides a manual choice made on
// another: dnd > invisible > online > idle. Invisible shows as offline.
var statusRank = map[v1.PresenceStatus]int{
	v1.PresenceStatus_PRESENCE_STATUS_IDLE:      1,
	v1.PresenceStatus_PRESENCE_STATUS_ONLINE:    2,
	v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE: 3,
	v1.PresenceStatus_PRESENCE_STATUS_DND:       4,
}

// AggregateStatus combines per-session statuses (see statusRank); no session = offline.
func AggregateStatus(statuses []v1.PresenceStatus) v1.PresenceStatus {
	best := v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	for _, s := range statuses {
		if statusRank[s] > statusRank[best] {
			best = s
		}
	}
	if best == v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE {
		return v1.PresenceStatus_PRESENCE_STATUS_OFFLINE
	}
	return best
}

type presenceStore struct {
	c   rueidis.Client
	ttl time.Duration
}

func presKey(u uuid.UUID) string     { return "presence:" + u.String() }
func presLastKey(u uuid.UUID) string { return "presence:last:" + u.String() }
func presSeenKey(u uuid.UUID) string { return "presence:seen:" + u.String() }

const presUsersKey = "presence:users"

// set records a session's status and renews its TTL.
func (p presenceStore) set(ctx context.Context, user, gsid uuid.UUID, st v1.PresenceStatus) error {
	now := time.Now()
	cmds := rueidis.Commands{
		p.c.B().Hset().Key(presKey(user)).FieldValue().FieldValue(gsid.String(), strconv.Itoa(int(st))).Build(),
		p.c.B().Hexpire().Key(presKey(user)).Seconds(int64(p.ttl.Seconds())).Fields().Numfields(1).Field(gsid.String()).Build(),
		p.c.B().Expire().Key(presKey(user)).Seconds(int64(p.ttl.Seconds()) + 60).Build(),
		p.c.B().Zadd().Key(presUsersKey).ScoreMember().ScoreMember(float64(now.UnixMilli()), user.String()).Build(),
	}
	if st != v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE {
		cmds = append(cmds, p.c.B().Set().Key(presSeenKey(user)).Value(strconv.FormatInt(now.UnixMilli(), 10)).Ex(90*24*time.Hour).Build())
	}
	for _, r := range p.c.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil {
			return err
		}
	}
	return nil
}

func (p presenceStore) remove(ctx context.Context, user, gsid uuid.UUID) error {
	return p.c.Do(ctx, p.c.B().Hdel().Key(presKey(user)).Field(gsid.String()).Build()).Error()
}

// get returns users' aggregated presence.
func (p presenceStore) get(ctx context.Context, users []uuid.UUID) (map[uuid.UUID]*v1.Presence, error) {
	out := make(map[uuid.UUID]*v1.Presence, len(users))
	if len(users) == 0 {
		return out, nil
	}
	cmds := make(rueidis.Commands, 0, 2*len(users))
	for _, u := range users {
		cmds = append(cmds, p.c.B().Hvals().Key(presKey(u)).Build(), p.c.B().Get().Key(presSeenKey(u)).Build())
	}
	res := p.c.DoMulti(ctx, cmds...)
	for i, u := range users {
		vals, err := res[2*i].AsStrSlice()
		if err != nil && !rueidis.IsRedisNil(err) {
			return nil, err
		}
		sts := make([]v1.PresenceStatus, 0, len(vals))
		for _, v := range vals {
			n, _ := strconv.Atoi(v)
			sts = append(sts, v1.PresenceStatus(n)) //nolint:gosec // small enum
		}
		pr := &v1.Presence{UserId: u.String(), Status: AggregateStatus(sts)}
		allInvisible := len(sts) > 0 && pr.GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_OFFLINE // invisible wins: hide last_seen
		if ms, err := res[2*i+1].AsInt64(); err == nil && !allInvisible {
			pr.LastSeen = timestamppb.New(time.UnixMilli(ms))
		}
		out[u] = pr
	}
	return out, nil
}

// changed stores the aggregate and reports whether it differs from the last published one.
func (p presenceStore) changed(ctx context.Context, pr *v1.Presence) (bool, error) {
	u, _ := uuid.Parse(pr.GetUserId())
	prev, err := p.c.Do(ctx, p.c.B().Getset().Key(presLastKey(u)).Value(strconv.Itoa(int(pr.GetStatus()))).Build()).ToString()
	if err != nil && !rueidis.IsRedisNil(err) {
		return false, err
	}
	if pr.GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		_ = p.c.Do(ctx, p.c.B().Zrem().Key(presUsersKey).Member(u.String()).Build()).Error()
	}
	return prev != strconv.Itoa(int(pr.GetStatus())), nil
}

// stale returns users not touched for longer than the TTL (candidates for going offline).
func (p presenceStore) stale(ctx context.Context) ([]uuid.UUID, error) {
	upTo := strconv.FormatInt(time.Now().Add(-p.ttl).UnixMilli(), 10)
	ms, err := p.c.Do(ctx, p.c.B().Zrangebyscore().Key(presUsersKey).Min("-inf").Max(upTo).Limit(0, 500).Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	out := make([]uuid.UUID, 0, len(ms))
	for _, m := range ms {
		if id, err := uuid.Parse(m); err == nil {
			out = append(out, id)
		}
	}
	return out, nil
}
