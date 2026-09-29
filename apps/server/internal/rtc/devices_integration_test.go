//go:build integration

package rtc

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/voice"
)

// disconnRec records VOICE_DISCONNECTED events sent to user channels.
type disconnRec struct {
	events.Nop
	mu  sync.Mutex
	got []*v1.VoiceDisconnected
}

func (r *disconnRec) User(_ context.Context, _ uuid.UUID, ev *v1.DispatchEvent) {
	if d := ev.GetVoiceDisconnected(); d != nil {
		r.mu.Lock()
		r.got = append(r.got, d)
		r.mu.Unlock()
	}
}

func (r *disconnRec) take() []*v1.VoiceDisconnected {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.got
	r.got = nil
	return out
}

// One device in voice at a time (docs/05 «Несколько устройств»): a /join from device B takes
// device A out of voice in another workspace — event to A, LiveKit participant removed, state
// cleared; a repeated /join of B touches nothing; A's stale LiveKit connection is not taken
// back by reconcile; A joining again itself takes B out in turn.
func TestJoinTakesOutOtherDevice(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	rec := &disconnRec{}
	s.events = rec
	ctx := context.Background()
	uid, a, b := uuid.New(), uuid.New(), uuid.New()
	s.sessionsOf = func(context.Context, uuid.UUID) ([]uuid.UUID, error) { return []uuid.UUID{a, b, uuid.New()}, nil }
	w1, r1, w2, r2 := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	room1 := wsRoom{Room: sqlc.Room{ID: r1}, WorkspaceID: w1}
	room2 := wsRoom{Room: sqlc.Room{ID: r2}, WorkspaceID: w2}
	join := func(room wsRoom, sid uuid.UUID) {
		t.Helper()
		if err := s.joinExclusive(ctx, uid, sid, func() error {
			_, _, err := s.recordPending(ctx, room, uid, sid, admission{})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	lkName1, idA := voice.RoomName(w1, r1), voice.Identity(uid, a)

	// A is connected in room 1 of workspace 1.
	join(room1, a)
	if err := s.setFlag(ctx, w1, r1, uid, a, func(n *voice.SessionState) { n.Pending = false }); err != nil {
		t.Fatal(err)
	}
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("first join took out a device: %v", got)
	}
	lk.rooms[lkName1] = []Participant{{Identity: idA}}

	// B joins room 2 of workspace 2: A is out.
	join(room2, b)
	got := rec.take()
	if len(got) != 1 || got[0].GetSessionId() != a.String() || got[0].GetRoomId() != r1.String() ||
		got[0].GetWorkspaceId() != w1.String() || got[0].GetReason() != v1.VoiceDisconnectReason_VOICE_DISCONNECT_REASON_OTHER_DEVICE {
		t.Fatalf("VOICE_DISCONNECTED: %v", got)
	}
	if !lk.wasRemoved(lkName1, idA) {
		t.Fatal("A not removed from LiveKit")
	}
	if st := stateOf(t, s, w1, a); st != nil {
		t.Fatalf("A's state kept: %+v", st)
	}
	if st := stateOf(t, s, w2, b); st == nil || st.RoomID != r2 {
		t.Fatalf("B's state: %+v", st)
	}
	if _, _, ok, _ := s.voice.Location(ctx, a); ok {
		t.Fatal("A still located in voice")
	}

	// Same session again (reconnect / repeated /join): nothing taken out.
	join(room2, b)
	if got := rec.take(); len(got) != 0 {
		t.Fatalf("repeated join took out a device: %v", got)
	}

	// A's LiveKit connection lingers (the fake keeps listing it): reconcile does not record it
	// back, it removes it again.
	lk.mu.Lock()
	lk.removed = nil
	lk.mu.Unlock()
	if err := s.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, s, w1, a); st != nil {
		t.Fatalf("reconcile recorded the superseded device: %+v", st)
	}
	if !lk.wasRemoved(lkName1, idA) {
		t.Fatal("reconcile kept the superseded device in LiveKit")
	}
	delete(lk.rooms, lkName1)

	// A joins again itself: its mark is gone and B is taken out.
	join(room1, a)
	if s.superseded(ctx, w1, r1, a) {
		t.Fatal("A still marked superseded after its own join")
	}
	if got := rec.take(); len(got) != 1 || got[0].GetSessionId() != b.String() || got[0].GetRoomId() != r2.String() {
		t.Fatalf("VOICE_DISCONNECTED for B: %v", got)
	}
	if !s.superseded(ctx, w2, r2, b) {
		t.Fatal("B not marked superseded")
	}
	if st := stateOf(t, s, w2, b); st != nil {
		t.Fatalf("B's state kept: %+v", st)
	}
}
