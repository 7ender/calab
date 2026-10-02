//go:build integration

package rtc

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/voice"
)

// presenceLK answers GetParticipant from the fake's room listing.
type presenceLK struct{ *fakeLK }

func (f presenceLK) GetParticipant(_ context.Context, room, identity string) (*Participant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, p := range f.rooms[room] {
		if p.Identity == identity {
			return &p, nil
		}
	}
	return nil, &Error{Code: "not_found"}
}

func stateOf(t *testing.T, s *Service, wid, sid uuid.UUID) *voice.SessionState {
	t.Helper()
	states, err := s.voice.List(context.Background(), wid)
	if err != nil {
		t.Fatal(err)
	}
	for i := range states {
		if states[i].SessionID == sid {
			return &states[i]
		}
	}
	return nil
}

// Optimistic join (docs/05): /join records the device as pending under the voice lock; a
// repeated /join is idempotent; pending devices count toward user_limit; the confirmation
// after connectConfirm removes a device that never connected, clears pending of one that
// did (participant_joined lost), and leaves a newer pending episode alone.
func TestPendingJoin(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	ctx := context.Background()
	wid, rid, other := uuid.New(), uuid.New(), uuid.New()
	room := wsRoom{Room: sqlc.Room{ID: rid, UserLimit: 1}, WorkspaceID: wid}
	ann, annS := uuid.New(), uuid.New()

	pending, joined, err := recordFixturePending(ctx, t, s, room, ann, annS, admissionFor(room, false))
	if err != nil || !pending || joined == 0 {
		t.Fatalf("first join: pending=%v joined=%d err=%v", pending, joined, err)
	}
	if st := stateOf(t, s, wid, annS); st == nil || st.RoomID != rid || !st.Pending {
		t.Fatalf("state after /join: %+v", st)
	}
	again, joined2, err := recordFixturePending(ctx, t, s, room, ann, annS, admissionFor(room, false))
	if err != nil || !again || joined2 != joined {
		t.Fatalf("repeated join not idempotent: pending=%v joined=%d/%d err=%v", again, joined2, joined, err)
	}

	// The pending user fills the limit of 1: somebody else is refused.
	if _, _, err := recordFixturePending(ctx, t, s, room, uuid.New(), uuid.New(), admissionFor(room, false)); !errors.Is(err, errRoomFull) {
		t.Fatalf("pending user not counted in user_limit: %v", err)
	}

	// Never connected: removed by the confirmation.
	s.confirmConnect(wid, rid, ann, annS, joined)
	if st := stateOf(t, s, wid, annS); st != nil {
		t.Fatalf("unconnected pending device kept: %+v", st)
	}

	// Connected without participant_joined: pending cleared, state kept.
	bob, bobS := uuid.New(), uuid.New()
	_, bj, err := recordFixturePending(ctx, t, s, room, bob, bobS, admission{})
	if err != nil {
		t.Fatal(err)
	}
	lk.rooms[voice.RoomName(wid, rid)] = []Participant{{Identity: voice.Identity(bob, bobS)}}
	s.confirmConnect(wid, rid, bob, bobS, bj)
	if st := stateOf(t, s, wid, bobS); st == nil || st.Pending || st.RoomID != rid {
		t.Fatalf("connected device: %+v", st)
	}

	// Left and joined again (another room, then back): the old timer does not touch the new wait.
	carl, carlS := uuid.New(), uuid.New()
	_, cj, _ := recordFixturePending(ctx, t, s, room, carl, carlS, admission{})
	_, _, _ = recordFixturePending(ctx, t, s, wsRoom{Room: sqlc.Room{ID: other}, WorkspaceID: wid}, carl, carlS, admission{})
	time.Sleep(2 * time.Millisecond)
	_, cj2, _ := recordFixturePending(ctx, t, s, room, carl, carlS, admission{})
	if cj2 == cj {
		t.Fatal("rejoin kept the old joined_at")
	}
	s.confirmConnect(wid, rid, carl, carlS, cj)
	if st := stateOf(t, s, wid, carlS); st == nil || !st.Pending {
		t.Fatalf("old confirmation removed a newer pending join: %+v", st)
	}
}

// Reconcile leaves a fresh pending state alone (the device is still connecting), removes a
// pending state older than joinGrace that never connected, and clears pending of a device
// LiveKit lists in its room.
func TestReconcilePending(t *testing.T) {
	wid, rid := uuid.New(), uuid.New()
	fresh, stale, live := uuid.New(), uuid.New(), uuid.New()
	u := uuid.New()
	lk := &fakeLK{rooms: map[string][]Participant{voice.RoomName(wid, rid): {{Identity: voice.Identity(u, live)}}}}
	s, _ := testService(t, lk)
	old := time.Now().Add(-2 * joinGrace).UnixMilli()
	for sid, at := range map[uuid.UUID]int64{fresh: 0, stale: old, live: old} {
		if _, err := s.voice.Update(context.Background(), wid, u, sid, func(*voice.SessionState) *voice.SessionState {
			return &voice.SessionState{RoomID: rid, Pending: true, JoinedAt: at}
		}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, s, wid, fresh); st == nil || !st.Pending {
		t.Fatalf("fresh pending state touched: %+v", st)
	}
	if st := stateOf(t, s, wid, stale); st != nil {
		t.Fatalf("stale pending state kept: %+v", st)
	}
	if st := stateOf(t, s, wid, live); st == nil || st.Pending {
		t.Fatalf("connected device still pending: %+v", st)
	}
}
