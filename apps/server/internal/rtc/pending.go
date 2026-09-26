package rtc

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/voice"
)

// connectConfirm: a device recorded in a room ahead of its LiveKit connection — an optimistic
// /join (docs/05) or an app-level move (ADR-0019) — that has not connected within this time
// is taken out of the room. A late connect is admitted normally by participant_joined.
const connectConfirm = 15 * time.Second

// expectConnect arms the confirmation of a pending device state recorded at joinedAt
// (SessionState.JoinedAt identifies the pending episode: a device that left and came back
// meanwhile has a newer one and is not touched by this timer). The timer is per process;
// Reconcile is the fallback when this instance goes away.
func (s *Service) expectConnect(wid, rid, uid, sid uuid.UUID, joinedAt int64) {
	time.AfterFunc(connectConfirm, func() { s.confirmConnect(wid, rid, uid, sid, joinedAt) })
}

// confirmConnect settles a pending device state after connectConfirm: connected to the room
// in LiveKit (participant_joined late or lost) → pending cleared; not there → the state is
// removed, which VOICE_STATE_UPDATE tells everyone (the device is in no call). LiveKit
// unreachable → left to Reconcile.
func (s *Service) confirmConnect(wid, rid, uid, sid uuid.UUID, joinedAt int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	identity := voice.Identity(uid, sid)
	_, err := s.lk.GetParticipant(ctx, voice.RoomName(wid, rid), identity)
	if err != nil && !IsNotFound(err) {
		return
	}
	connected := err == nil
	if err := s.update(ctx, wid, uid, sid, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != rid || !cur.Pending || cur.JoinedAt != joinedAt {
			return cur // connected, left, moved on or joined again since
		}
		if connected {
			n := *cur
			n.Pending = false
			return &n
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "settle a pending voice state", "identity", identity, "err", err)
	}
}

// dropPending removes a device state that is still pending in st's room: a device the server
// takes out of voice (lost access, kicked, session revoked) before it reached LiveKit has no
// participant_left to clear its state. A connected device is left to participant_left.
func (s *Service) dropPending(ctx context.Context, wid uuid.UUID, st voice.SessionState) {
	if !st.Pending {
		return
	}
	if err := s.update(ctx, wid, st.UserID, st.SessionID, func(cur *voice.SessionState) *voice.SessionState {
		if cur == nil || cur.RoomID != st.RoomID || !cur.Pending {
			return cur
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "drop a pending voice state", "session", st.SessionID, "err", err)
	}
}
