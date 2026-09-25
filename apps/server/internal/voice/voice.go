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
package voice

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

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
	for _, s := range sessions {
		if s.UserID != userID || s.RoomID != latest.RoomID {
			continue
		}
		out.Muted = out.Muted && s.Muted
		out.Deafened = out.Deafened && s.Deafened
		out.Streaming = out.Streaming || s.Streaming
	}
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
		a.GetDeafened() == b.GetDeafened() && a.GetStreaming() == b.GetStreaming()
}

// Store is the Redis-backed voice state.
type Store struct{ C rueidis.Client }

func wsKey(wid uuid.UUID) string          { return "voice:ws:" + wid.String() }
func sessKey(sid uuid.UUID) string        { return "voice:sess:" + sid.String() }
func streamsKey(rid uuid.UUID) string     { return "voice:streams:" + rid.String() }
func streamReqKey(identity string) string { return "voice:streamreq:" + identity }

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

// Update applies fn to the session's state (nil = absent; returning nil removes it) and
// returns the user's aggregate before/after.
func (s Store) Update(ctx context.Context, wid, userID, sessionID uuid.UUID, fn func(cur *SessionState) *SessionState) (Change, error) {
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
	for _, r := range s.C.DoMulti(ctx, cmds...) {
		if err := r.Error(); err != nil {
			return Change{}, err
		}
	}
	return Change{Before: before, After: Aggregate(wid, userID, rest)}, nil
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

// AddStream records a stream and returns the number of streams in the room after adding.
func (s Store) AddStream(ctx context.Context, rid uuid.UUID, trackSID string, st Stream) (int64, error) {
	b, _ := json.Marshal(st)
	res := s.C.DoMulti(ctx,
		s.C.B().Hset().Key(streamsKey(rid)).FieldValue().FieldValue(trackSID, string(b)).Build(),
		s.C.B().Hlen().Key(streamsKey(rid)).Build())
	if err := res[0].Error(); err != nil {
		return 0, err
	}
	return res[1].AsInt64()
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
