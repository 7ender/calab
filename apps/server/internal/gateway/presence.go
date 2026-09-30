package gateway

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/calls"
	"github.com/calaba/calaba/server/internal/redisx"
)

// Presence keys (docs/05; inside the key namespace, redisx.Key):
//
//	presence:<user_id>       hash gateway_session_id -> "<status>[|<identify ms>|<platform>|<version>]"
//	                         (see encodeSession), each field with its own TTL (HEXPIRE,
//	                         Redis ≥ 7.4) of 2×heartbeat, renewed by heartbeats
//	presence:last:<user_id>  last published aggregate (to publish only on change)
//	presence:seen:<user_id>  "<unix ms>[|<platform>|<version>]": the last activity of a visible
//	                         session and its client (Presence.client_* when offline)
//	presence:users           zset user_id -> last touch (for the offline sweeper)
//	presence:manual:<user_id> the user's manual status "<status>:<until unix ms, 0 = no end>",
//	                         expiring at until (PXAT); the durable copy is users.presence_*
//	call:oncall:<user_id>    set while the user is in an ACTIVE one-to-one call (internal/calls):
//	                         Presence.on_call, shown only with a visible status

// Session statuses combine by priority: manual statuses (dnd, invisible) always win over
// automatic ones, so an AFK "idle" from one device never overrides a manual choice made on
// another: dnd > invisible > online > idle. Invisible shows as offline.
var statusRank = map[v1.PresenceStatus]int{
	v1.PresenceStatus_PRESENCE_STATUS_IDLE:      1,
	v1.PresenceStatus_PRESENCE_STATUS_ONLINE:    2,
	v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE: 3,
	v1.PresenceStatus_PRESENCE_STATUS_DND:       4,
}

// manualStatus is a user's manual status (SetPresence with until), shared by all devices.
type manualStatus struct {
	status v1.PresenceStatus // IDLE | DND | INVISIBLE; UNSPECIFIED = none
	until  time.Time         // zero = no end
}

func (m manualStatus) active(now time.Time) bool {
	return m.status != v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED && (m.until.IsZero() || now.Before(m.until))
}

func (m manualStatus) encode() string {
	var ms int64
	if !m.until.IsZero() {
		ms = m.until.UnixMilli()
	}
	return strconv.Itoa(int(m.status)) + ":" + strconv.FormatInt(ms, 10)
}

func decodeManual(v string) manualStatus {
	st, ms, ok := strings.Cut(v, ":")
	if !ok {
		return manualStatus{}
	}
	n, err1 := strconv.Atoi(st)
	u, err2 := strconv.ParseInt(ms, 10, 64)
	if err1 != nil || err2 != nil || !manualAllowed(v1.PresenceStatus(n)) { //nolint:gosec // small enum
		return manualStatus{}
	}
	m := manualStatus{status: v1.PresenceStatus(n)} //nolint:gosec // small enum
	if u > 0 {
		m.until = time.UnixMilli(u)
	}
	return m
}

func manualAllowed(st v1.PresenceStatus) bool {
	switch st {
	case v1.PresenceStatus_PRESENCE_STATUS_IDLE, v1.PresenceStatus_PRESENCE_STATUS_DND, v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE:
		return true
	}
	return false
}

// manualFromDB reads users.presence_status / presence_until; an ended one is none.
func manualFromDB(st *int16, until *time.Time, now time.Time) manualStatus {
	if st == nil || !manualAllowed(v1.PresenceStatus(*st)) {
		return manualStatus{}
	}
	m := manualStatus{status: v1.PresenceStatus(*st)}
	if until != nil {
		m.until = *until
	}
	if !m.active(now) {
		return manualStatus{}
	}
	return m
}

// self is the user's own view of their manual status (Ready.presence, USER_UPDATE.presence):
// the chosen status, INVISIBLE included; ONLINE with no until when there is none.
func (m manualStatus) self(user uuid.UUID) *v1.Presence {
	p := &v1.Presence{UserId: user.String(), Status: m.status}
	if m.status == v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		p.Status = v1.PresenceStatus_PRESENCE_STATUS_ONLINE
	}
	if !m.until.IsZero() {
		p.Until = timestamppb.New(m.until)
	}
	return p
}

// Aggregate is the status others see: offline without live sessions; otherwise an active
// manual status wins over the sessions' automatic ones (invisible shows as offline, with no
// until); else AggregateStatus. until is set only for a visible manual status with an end.
func Aggregate(statuses []v1.PresenceStatus, m manualStatus, now time.Time) (v1.PresenceStatus, time.Time) {
	if len(statuses) == 0 {
		return v1.PresenceStatus_PRESENCE_STATUS_OFFLINE, time.Time{}
	}
	if !m.active(now) {
		return AggregateStatus(statuses), time.Time{}
	}
	if m.status == v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE {
		return v1.PresenceStatus_PRESENCE_STATUS_OFFLINE, time.Time{}
	}
	return m.status, m.until
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

// clientInfo is the app a gateway session runs (Identify.device, docs/09 #143). Presence shows
// the one of the most recently identified live session.
type clientInfo struct {
	since    int64  // IDENTIFY time, unix ms
	platform string // web | darwin | win32 | linux; "" = unknown
	version  string // «1.1.0»; "" = unknown
}

func (c clientInfo) known() bool { return c.platform != "" || c.version != "" }

// maxClientVersion bounds the stored version (a semver with a pre-release tag fits).
const maxClientVersion = 32

// newClientInfo keeps only a known platform and a plain version string (no separators).
func newClientInfo(d *v1.DeviceInfo, now time.Time) clientInfo {
	c := clientInfo{since: now.UnixMilli()}
	switch p := d.GetPlatform(); p {
	case "web", "darwin", "win32", "linux":
		c.platform = p
	}
	v := strings.TrimSpace(d.GetAppVersion())
	if len(v) <= maxClientVersion && v != "" && strings.Trim(v, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-") == "" {
		c.version = strings.TrimPrefix(v, "v")
	}
	return c
}

// encodeSession is a session's presence hash value: the bare status (old format, bots) or
// "<status>|<since>|<platform>|<version>".
func encodeSession(st v1.PresenceStatus, c clientInfo) string {
	if !c.known() {
		return strconv.Itoa(int(st))
	}
	return strconv.Itoa(int(st)) + "|" + strconv.FormatInt(c.since, 10) + "|" + c.platform + "|" + c.version
}

func decodeSession(v string) (v1.PresenceStatus, clientInfo) {
	parts := strings.SplitN(v, "|", 4)
	n, _ := strconv.Atoi(parts[0])
	st := v1.PresenceStatus(n) //nolint:gosec // small enum
	if len(parts) < 4 {
		return st, clientInfo{}
	}
	since, _ := strconv.ParseInt(parts[1], 10, 64)
	return st, clientInfo{since: since, platform: parts[2], version: parts[3]}
}

// encodeSeen / decodeSeen: presence:seen value ("<ms>" before docs/09 #143).
func encodeSeen(now time.Time, c clientInfo) string {
	ms := strconv.FormatInt(now.UnixMilli(), 10)
	if !c.known() {
		return ms
	}
	return ms + "|" + c.platform + "|" + c.version
}

func decodeSeen(v string) (int64, clientInfo, bool) {
	parts := strings.SplitN(v, "|", 3)
	ms, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, clientInfo{}, false
	}
	if len(parts) < 3 {
		return ms, clientInfo{}, true
	}
	return ms, clientInfo{since: ms, platform: parts[1], version: parts[2]}, true
}

type presenceStore struct {
	c   rueidis.Client
	ttl time.Duration
}

func presKey(u uuid.UUID) string     { return redisx.Key("presence:" + u.String()) }
func presLastKey(u uuid.UUID) string { return redisx.Key("presence:last:" + u.String()) }
func presSeenKey(u uuid.UUID) string { return redisx.Key("presence:seen:" + u.String()) }
func presManualKey(u uuid.UUID) string {
	return redisx.Key("presence:manual:" + u.String())
}
func presUsersKey() string { return redisx.Key("presence:users") }

// set records a session's status (and its client) and renews its TTL.
func (p presenceStore) set(ctx context.Context, user, gsid uuid.UUID, st v1.PresenceStatus, c clientInfo) error {
	now := time.Now()
	cmds := rueidis.Commands{
		p.c.B().Hset().Key(presKey(user)).FieldValue().FieldValue(gsid.String(), encodeSession(st, c)).Build(),
		p.c.B().Hexpire().Key(presKey(user)).Seconds(int64(p.ttl.Seconds())).Fields().Numfields(1).Field(gsid.String()).Build(),
		p.c.B().Expire().Key(presKey(user)).Seconds(int64(p.ttl.Seconds()) + 60).Build(),
		p.c.B().Zadd().Key(presUsersKey()).ScoreMember().ScoreMember(float64(now.UnixMilli()), user.String()).Build(),
	}
	if st != v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE {
		cmds = append(cmds, p.c.B().Set().Key(presSeenKey(user)).Value(encodeSeen(now, c)).Ex(90*24*time.Hour).Build())
	}
	for _, r := range p.c.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil {
			return err
		}
	}
	return nil
}

// client returns the client a live session stored (a session taken over from another
// instance keeps it); none when unknown.
func (p presenceStore) client(ctx context.Context, user, gsid uuid.UUID) clientInfo {
	v, err := p.c.Do(ctx, p.c.B().Hget().Key(presKey(user)).Field(gsid.String()).Build()).ToString()
	if err != nil {
		return clientInfo{}
	}
	_, c := decodeSession(v)
	return c
}

func (p presenceStore) remove(ctx context.Context, user, gsid uuid.UUID) error {
	return p.c.Do(ctx, p.c.B().Hdel().Key(presKey(user)).Field(gsid.String()).Build()).Error()
}

// get returns users' aggregated presence (as others see it).
func (p presenceStore) get(ctx context.Context, users []uuid.UUID) (map[uuid.UUID]*v1.Presence, error) {
	out := make(map[uuid.UUID]*v1.Presence, len(users))
	if len(users) == 0 {
		return out, nil
	}
	const per = 4 // commands per user
	cmds := make(rueidis.Commands, 0, per*len(users))
	for _, u := range users {
		cmds = append(cmds, p.c.B().Hvals().Key(presKey(u)).Build(), p.c.B().Get().Key(presSeenKey(u)).Build(),
			p.c.B().Get().Key(presManualKey(u)).Build(), p.c.B().Exists().Key(calls.OnCallKey(u)).Build())
	}
	res := p.c.DoMulti(ctx, cmds...)
	now := time.Now()
	for i, u := range users {
		vals, err := res[per*i].AsStrSlice()
		if err != nil && !rueidis.IsRedisNil(err) {
			return nil, err
		}
		seen, err := res[per*i+1].ToString()
		if err != nil && !rueidis.IsRedisNil(err) {
			return nil, err
		}
		var m manualStatus
		if v, err := res[per*i+2].ToString(); err == nil {
			m = decodeManual(v)
		} else if !rueidis.IsRedisNil(err) {
			return nil, err
		}
		n, err := res[per*i+3].AsInt64()
		onCall := err == nil && n > 0
		out[u] = presenceOf(u, vals, seen, m, onCall, now)
	}
	return out, nil
}

// presenceOf builds the presence others see from the stored values: the sessions' hash
// values, presence:seen ("" = none), the manual status and the on-call flag.
func presenceOf(u uuid.UUID, vals []string, seen string, m manualStatus, onCall bool, now time.Time) *v1.Presence {
	sts := make([]v1.PresenceStatus, 0, len(vals))
	var latest clientInfo // of the most recently identified live session
	for _, v := range vals {
		st, c := decodeSession(v)
		sts = append(sts, st)
		if c.known() && c.since >= latest.since {
			latest = c
		}
	}
	st, until := Aggregate(sts, m, now)
	pr := &v1.Presence{UserId: u.String(), Status: st}
	if !until.IsZero() {
		pr.Until = timestamppb.New(until)
	}
	// «На звонке» (ADR-0034) only with a visible status: offline / invisible hide it.
	if onCall && st != v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		pr.OnCall = true
	}
	// Invisible (chosen on every session, or as the manual status) also hides last_seen and
	// the client.
	hidden := (len(sts) > 0 && AggregateStatus(sts) == v1.PresenceStatus_PRESENCE_STATUS_OFFLINE) ||
		(m.active(now) && m.status == v1.PresenceStatus_PRESENCE_STATUS_INVISIBLE)
	if hidden {
		return pr
	}
	if ms, c, ok := decodeSeen(seen); ok {
		pr.LastSeen = timestamppb.New(time.UnixMilli(ms))
		if len(sts) == 0 {
			latest = c // offline: the client last seen active
		}
	}
	pr.ClientVersion, pr.ClientPlatform = latest.version, latest.platform
	return pr
}

// setManual stores the user's manual status in Valkey, expiring at its end; none deletes it.
func (p presenceStore) setManual(ctx context.Context, user uuid.UUID, m manualStatus) error {
	if m.status == v1.PresenceStatus_PRESENCE_STATUS_UNSPECIFIED {
		return p.c.Do(ctx, p.c.B().Del().Key(presManualKey(user)).Build()).Error()
	}
	if m.until.IsZero() {
		return p.c.Do(ctx, p.c.B().Set().Key(presManualKey(user)).Value(m.encode()).Build()).Error()
	}
	return p.c.Do(ctx, p.c.B().Set().Key(presManualKey(user)).Value(m.encode()).Pxat(m.until).Build()).Error()
}

// restoreManual puts a manual status from Postgres back into Valkey unless one is there.
func (p presenceStore) restoreManual(ctx context.Context, user uuid.UUID, m manualStatus) error {
	if m.until.IsZero() {
		return p.c.Do(ctx, p.c.B().Set().Key(presManualKey(user)).Value(m.encode()).Nx().Build()).Error()
	}
	return p.c.Do(ctx, p.c.B().Set().Key(presManualKey(user)).Value(m.encode()).Nx().Pxat(m.until).Build()).Error()
}

// dropManual deletes the Valkey copy of an ended manual status only if it is still that
// one (a newer choice made meanwhile stays).
func (p presenceStore) dropManual(ctx context.Context, user uuid.UUID, m manualStatus) error {
	return dropIfScript.Exec(ctx, p.c, []string{presManualKey(user)}, []string{m.encode()}).Error()
}

var dropIfScript = rueidis.NewLuaScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`)

// changed stores the aggregate (status and until) and reports whether it differs from the
// last published one.
func (p presenceStore) changed(ctx context.Context, pr *v1.Presence) (bool, error) {
	u, _ := uuid.Parse(pr.GetUserId())
	cur := strconv.Itoa(int(pr.GetStatus()))
	if pr.GetUntil() != nil {
		cur += ":" + strconv.FormatInt(pr.GetUntil().AsTime().UnixMilli(), 10)
	}
	if pr.GetOnCall() {
		cur += ":call"
	}
	if pr.GetClientVersion() != "" || pr.GetClientPlatform() != "" {
		cur += "|" + pr.GetClientPlatform() + "|" + pr.GetClientVersion()
	}
	prev, err := p.c.Do(ctx, p.c.B().Set().Key(presLastKey(u)).Value(cur).Get().Ex(30*24*time.Hour).Build()).ToString()
	if err != nil && !rueidis.IsRedisNil(err) {
		return false, err
	}
	if pr.GetStatus() == v1.PresenceStatus_PRESENCE_STATUS_OFFLINE {
		_ = p.c.Do(ctx, p.c.B().Zrem().Key(presUsersKey()).Member(u.String()).Build()).Error()
	}
	return prev != cur, nil
}

// stale returns users not touched for longer than the TTL (candidates for going offline).
func (p presenceStore) stale(ctx context.Context) ([]uuid.UUID, error) {
	upTo := strconv.FormatInt(time.Now().Add(-p.ttl).UnixMilli(), 10)
	ms, err := p.c.Do(ctx, p.c.B().Zrangebyscore().Key(presUsersKey()).Min("-inf").Max(upTo).Limit(0, 500).Build()).AsStrSlice()
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
