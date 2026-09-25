// Package voice keeps voice state in Redis, per device session, and aggregates it per user
// (docs/05 "Несколько устройств"). LiveKit webhooks + reconcile are the source of truth;
// PATCH /api/voice/self applies optimistic mute/deafen.
//
// Keys:
//
//	voice:ws:<workspace_id>      hash  "<user_id>:<session_id>" -> JSON SessionState
//	voice:sess:<session_id>      string "<workspace_id>/<room_id>" (where a device is connected)
//	voice:streams:<room_id>      hash  track_sid -> JSON Stream
//	voice:streamreq:<identity>   string preset reserved by /stream/request (TTL 10 min)
//	voice:workspaces             set   workspaces with any voice state (for reconcile)
//	voice:started:<room_id>      string unix ms when the current call began (first device in an empty room)
package voice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// SessionState is the voice state of one device (LiveKit participant).
type SessionState struct {
	UserID    uuid.UUID `json:"u"`
	SessionID uuid.UUID `json:"s"`
	RoomID    uuid.UUID `json:"r"`
	Muted     bool      `json:"m,omitempty"`
	Deafened  bool      `json:"d,omitempty"`
	Streaming bool      `json:"st,omitempty"`
	JoinedAt  int64     `json:"j"` // unix ms
}

// Stream is an active screen share track.
type Stream struct {
	Identity string               `json:"i"`
	UserID   uuid.UUID            `json:"u"`
	Preset   v1.ScreenSharePreset `json:"p"`
	Started  int64                `json:"t"`
}

// Identity is the LiveKit participant identity of a device session.
func Identity(userID, sessionID uuid.UUID) string { return userID.String() + ":" + sessionID.String() }

// ParseIdentity splits "<user_id>:<session_id>".
func ParseIdentity(id string) (userID, sessionID uuid.UUID, ok bool) {
	u, s, found := strings.Cut(id, ":")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	uid, err1 := uuid.Parse(u)
	sid, err2 := uuid.Parse(s)
	return uid, sid, err1 == nil && err2 == nil
}

// RoomName is the LiveKit room name of a Calaba voice room.
func RoomName(workspaceID, roomID uuid.UUID) string {
	return "ws_" + workspaceID.String() + "_room_" + roomID.String()
}

// ParseRoomName is the inverse of RoomName.
func ParseRoomName(name string) (workspaceID, roomID uuid.UUID, ok bool) {
	rest, found := strings.CutPrefix(name, "ws_")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	w, r, found := strings.Cut(rest, "_room_")
	if !found {
		return uuid.Nil, uuid.Nil, false
	}
	wid, err1 := uuid.Parse(w)
	rid, err2 := uuid.Parse(r)
	return wid, rid, err1 == nil && err2 == nil
}

// Aggregate computes the per-user voice state from all of the user's device sessions in a
// workspace: the user is in the room of their most recently joined session; muted/deafened
// = all sessions in that room are; streaming = any session in that room is.
// Returns a state with empty RoomId when the user has no sessions.
func Aggregate(workspaceID, userID uuid.UUID, sessions []SessionState) *v1.VoiceState {
	out := &v1.VoiceState{WorkspaceId: workspaceID.String(), UserId: userID.String()}
	var latest *SessionState
	for i := range sessions {
		s := &sessions[i]
		if s.UserID != userID {
			continue
		}
		if latest == nil || s.JoinedAt > latest.JoinedAt || (s.JoinedAt == latest.JoinedAt && s.SessionID.String() > latest.SessionID.String()) {
			latest = s
		}
	}
	if latest == nil {
		return out
	}
	out.RoomId = latest.RoomID.String()
	out.Muted, out.Deafened = true, true
	joined := latest.JoinedAt
	for _, s := range sessions {
		if s.UserID != userID || s.RoomID != latest.RoomID {
			continue
		}
		out.Muted = out.Muted && s.Muted
		out.Deafened = out.Deafened && s.Deafened
		out.Streaming = out.Streaming || s.Streaming
		joined = min(joined, s.JoinedAt)
	}
	out.JoinedAt = timestamppb.New(time.UnixMilli(joined))
	return out
}

// AggregateAll returns one state per user present in sessions, sorted by user id.
func AggregateAll(workspaceID uuid.UUID, sessions []SessionState) []*v1.VoiceState {
	users := map[uuid.UUID]bool{}
	for _, s := range sessions {
		users[s.UserID] = true
	}
	out := make([]*v1.VoiceState, 0, len(users))
	for u := range users {
		out = append(out, Aggregate(workspaceID, u, sessions))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetUserId() < out[j].GetUserId() })
	return out
}

// Equal compares two aggregated states.
func Equal(a, b *v1.VoiceState) bool {
	return a.GetRoomId() == b.GetRoomId() && a.GetMuted() == b.GetMuted() &&
		a.GetDeafened() == b.GetDeafened() && a.GetStreaming() == b.GetStreaming() &&
		a.GetJoinedAt().AsTime().Equal(b.GetJoinedAt().AsTime())
}

// Store is the Redis-backed voice state.
type Store struct{ C rueidis.Client }

func wsKey(wid uuid.UUID) string          { return "voice:ws:" + wid.String() }
func sessKey(sid uuid.UUID) string        { return "voice:sess:" + sid.String() }
func streamsKey(rid uuid.UUID) string     { return "voice:streams:" + rid.String() }
func streamReqKey(identity string) string { return "voice:streamreq:" + identity }
func startedKey(rid uuid.UUID) string     { return "voice:started:" + rid.String() }

const workspacesKey = "voice:workspaces"

// List returns all device sessions in a workspace.
func (s Store) List(ctx context.Context, wid uuid.UUID) ([]SessionState, error) {
	m, err := s.C.Do(ctx, s.C.B().Hgetall().Key(wsKey(wid)).Build()).AsStrMap()
	if err != nil {
		return nil, err
	}
	out := make([]SessionState, 0, len(m))
	for _, v := range m {
		var st SessionState
		if json.Unmarshal([]byte(v), &st) == nil {
			out = append(out, st)
		}
	}
	return out, nil
}

// Workspaces returns workspaces that may have voice state.
func (s Store) Workspaces(ctx context.Context) ([]uuid.UUID, error) {
	ms, err := s.C.Do(ctx, s.C.B().Smembers().Key(workspacesKey).Build()).AsStrSlice()
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

// Change is the result of a mutation: the user's aggregate before and after.
type Change struct {
	Before, After *v1.VoiceState
}

// Changed reports whether the aggregate changed (i.e. VOICE_STATE_UPDATE is due).
func (c Change) Changed() bool { return !Equal(c.Before, c.After) }

var errLockTimeout = errors.New("voice: workspace lock timeout")

// unlockScript deletes the lock only if we still own it.
var unlockScript = rueidis.NewLuaScript(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`)

// WithLock runs fn holding the workspace's voice lock: all read-modify-write of voice
// state (and checks that must be atomic with it, like user_limit) happen under it.
func (s Store) WithLock(ctx context.Context, wid uuid.UUID, fn func() error) error {
	key, token := "voice:lock:"+wid.String(), uuid.NewString()
	deadline := time.Now().Add(3 * time.Second)
	for {
		err := s.C.Do(ctx, s.C.B().Set().Key(key).Value(token).Nx().Px(5*time.Second).Build()).Error()
		if err == nil {
			break
		}
		if !rueidis.IsRedisNil(err) {
			return err
		}
		if time.Now().After(deadline) {
			return errLockTimeout
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
	defer unlockScript.Exec(context.WithoutCancel(ctx), s.C, []string{key}, []string{token})
	return fn()
}

// Update applies fn to the session's state (nil = absent; returning nil removes it) and
// returns the user's aggregate before/after. Atomic per workspace (WithLock).
func (s Store) Update(ctx context.Context, wid, userID, sessionID uuid.UUID, fn func(cur *SessionState) *SessionState) (Change, error) {
	var c Change
	err := s.WithLock(ctx, wid, func() error {
		var err error
		c, err = s.UpdateLocked(ctx, wid, userID, sessionID, fn)
		return err
	})
	return c, err
}

// UpdateLocked is Update for callers already inside WithLock.
func (s Store) UpdateLocked(ctx context.Context, wid, userID, sessionID uuid.UUID, fn func(cur *SessionState) *SessionState) (Change, error) {
	all, err := s.List(ctx, wid)
	if err != nil {
		return Change{}, err
	}
	before := Aggregate(wid, userID, all)
	var cur *SessionState
	rest := all[:0:0]
	for i := range all {
		if all[i].UserID == userID && all[i].SessionID == sessionID {
			c := all[i]
			cur = &c
			continue
		}
		rest = append(rest, all[i])
	}
	next := fn(cur)
	field := Identity(userID, sessionID)
	var cmds rueidis.Commands
	if next == nil {
		cmds = append(cmds, s.C.B().Hdel().Key(wsKey(wid)).Field(field).Build(),
			s.C.B().Del().Key(sessKey(sessionID)).Build())
	} else {
		next.UserID, next.SessionID = userID, sessionID
		if next.JoinedAt == 0 {
			next.JoinedAt = time.Now().UnixMilli()
		}
		b, _ := json.Marshal(next)
		cmds = append(cmds, s.C.B().Hset().Key(wsKey(wid)).FieldValue().FieldValue(field, string(b)).Build(),
			s.C.B().Set().Key(sessKey(sessionID)).Value(wid.String()+"/"+next.RoomID.String()).Build(),
			s.C.B().Sadd().Key(workspacesKey).Member(wid.String()).Build())
		rest = append(rest, *next)
	}
	// Call start per room: set when a room gains its first device, cleared when it empties.
	for _, rid := range touchedRooms(cur, next) {
		if occupied(rest, rid) {
			cmds = append(cmds, s.C.B().Set().Key(startedKey(rid)).Value(strconv.FormatInt(time.Now().UnixMilli(), 10)).Nx().Build())
		} else {
			cmds = append(cmds, s.C.B().Del().Key(startedKey(rid)).Build())
		}
	}
	for _, r := range s.C.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil && !rueidis.IsRedisNil(err) {
			return Change{}, err
		}
	}
	return Change{Before: before, After: Aggregate(wid, userID, rest)}, nil
}

func touchedRooms(cur, next *SessionState) []uuid.UUID {
	var out []uuid.UUID
	if cur != nil {
		out = append(out, cur.RoomID)
	}
	if next != nil && (cur == nil || next.RoomID != cur.RoomID) {
		out = append(out, next.RoomID)
	}
	return out
}

func occupied(sessions []SessionState, rid uuid.UUID) bool {
	for _, s := range sessions {
		if s.RoomID == rid {
			return true
		}
	}
	return false
}

// StartedAt returns when the current call in each room began (rooms without a call are absent).
func (s Store) StartedAt(ctx context.Context, rids []uuid.UUID) (map[uuid.UUID]time.Time, error) {
	out := map[uuid.UUID]time.Time{}
	if len(rids) == 0 {
		return out, nil
	}
	cmds := make(rueidis.Commands, len(rids))
	for i, r := range rids {
		cmds[i] = s.C.B().Get().Key(startedKey(r)).Build()
	}
	for i, res := range s.C.DoMulti(ctx, cmds...) {
		ms, err := res.AsInt64()
		if rueidis.IsRedisNil(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[rids[i]] = time.UnixMilli(ms)
	}
	return out, nil
}

// Forget removes a workspace from the reconcile set if it has no voice state.
func (s Store) Forget(ctx context.Context, wid uuid.UUID) error {
	return s.WithLock(ctx, wid, func() error {
		n, err := s.C.Do(ctx, s.C.B().Hlen().Key(wsKey(wid)).Build()).AsInt64()
		if err != nil || n > 0 {
			return err
		}
		return s.C.Do(ctx, s.C.B().Srem().Key(workspacesKey).Member(wid.String()).Build()).Error()
	})
}

// Location returns where a device session is connected (ok=false if not in voice).
func (s Store) Location(ctx context.Context, sessionID uuid.UUID) (wid, rid uuid.UUID, ok bool, err error) {
	v, err := s.C.Do(ctx, s.C.B().Get().Key(sessKey(sessionID)).Build()).ToString()
	if rueidis.IsRedisNil(err) {
		return uuid.Nil, uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, false, err
	}
	w, r, _ := strings.Cut(v, "/")
	wid, err1 := uuid.Parse(w)
	rid, err2 := uuid.Parse(r)
	return wid, rid, err1 == nil && err2 == nil, nil
}

// Streams returns active streams in a room keyed by track sid.
func (s Store) Streams(ctx context.Context, rid uuid.UUID) (map[string]Stream, error) {
	m, err := s.C.Do(ctx, s.C.B().Hgetall().Key(streamsKey(rid)).Build()).AsStrMap()
	if err != nil {
		return nil, err
	}
	out := make(map[string]Stream, len(m))
	for k, v := range m {
		var st Stream
		if json.Unmarshal([]byte(v), &st) == nil {
			out[k] = st
		}
	}
	return out, nil
}

// addStream atomically records a stream unless the room already has `max` other streams.
var addStream = rueidis.NewLuaScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 1 end
local max = tonumber(ARGV[3])
if max >= 0 and redis.call('HLEN', KEYS[1]) >= max then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`)

// AddStream records a stream if the room has fewer than limit streams (limit < 0: none).
// Check and insert are one atomic step, so two concurrent streams cannot both pass.
func (s Store) AddStream(ctx context.Context, rid uuid.UUID, trackSID string, st Stream, limit int) (bool, error) {
	b, _ := json.Marshal(st)
	n, err := addStream.Exec(ctx, s.C, []string{streamsKey(rid)}, []string{trackSID, string(b), strconv.Itoa(limit)}).AsInt64()
	return n == 1, err
}

// RemoveStream deletes a stream; ok=false if it was not recorded.
func (s Store) RemoveStream(ctx context.Context, rid uuid.UUID, trackSID string) (bool, error) {
	n, err := s.C.Do(ctx, s.C.B().Hdel().Key(streamsKey(rid)).Field(trackSID).Build()).AsInt64()
	return n > 0, err
}

// ClearRoom removes a room's streams (room finished).
func (s Store) ClearRoom(ctx context.Context, rid uuid.UUID) error {
	return s.C.Do(ctx, s.C.B().Del().Key(streamsKey(rid)).Build()).Error()
}

// ReserveStream stores the preset requested by a device (consumed by track_published).
func (s Store) ReserveStream(ctx context.Context, identity string, p v1.ScreenSharePreset) error {
	return s.C.Do(ctx, s.C.B().Set().Key(streamReqKey(identity)).Value(fmt.Sprint(int32(p))).Ex(10*time.Minute).Build()).Error()
}

// ReservedStream returns the reserved preset (UNSPECIFIED if none).
func (s Store) ReservedStream(ctx context.Context, identity string) v1.ScreenSharePreset {
	n, err := s.C.Do(ctx, s.C.B().Get().Key(streamReqKey(identity)).Build()).AsInt64()
	if err != nil {
		return v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED
	}
	return v1.ScreenSharePreset(n) //nolint:gosec // small enum
}
