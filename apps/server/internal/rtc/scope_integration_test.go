//go:build integration

package rtc

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/voice"
)

// A device's location (voice:sess) is cleared only within its own scope (ADR-0034): when a
// device moves from a workspace room into a DM call, or into another workspace, the old
// room's late participant_left removes only the old scope's state and keeps the new
// location; leaving the new scope then clears it. No ghost state stays in either scope.
func TestLocationSurvivesOldScopeLeave(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	ctx := context.Background()
	u, sid := uuid.New(), uuid.New()
	identity := voice.Identity(u, sid)

	location := func() (uuid.UUID, uuid.UUID, bool) {
		t.Helper()
		w, r, ok, err := s.voice.Location(ctx, sid)
		if err != nil {
			t.Fatal(err)
		}
		return w, r, ok
	}
	left := func(wid, rid uuid.UUID) {
		t.Helper()
		ev := &WebhookEvent{Event: EventParticipantLeft, Room: &Room{Name: voice.RoomName(wid, rid)},
			Participant: &Participant{Identity: identity}}
		if err := s.HandleEvent(ctx, ev); err != nil {
			t.Fatal(err)
		}
	}
	// A DM scope is written through the store: publishing a DM voice change needs Postgres
	// (the DM's members), which this package's tests do not have.
	dmSet := func(dm uuid.UUID) {
		t.Helper()
		if _, err := s.voice.Update(ctx, dm, u, sid, func(*voice.SessionState) *voice.SessionState {
			return &voice.SessionState{RoomID: dm}
		}); err != nil {
			t.Fatal(err)
		}
	}
	dmDrop := func(dm uuid.UUID) {
		t.Helper()
		if _, err := s.voice.Update(ctx, dm, u, sid, func(*voice.SessionState) *voice.SessionState { return nil }); err != nil {
			t.Fatal(err)
		}
	}

	// Workspace room → DM call; the workspace room's participant_left arrives after the join.
	w1, a := uuid.New(), uuid.New()
	dm := uuid.New()
	setState(t, s, w1, u, sid, a, 0)
	dmSet(dm)
	left(w1, a)
	if st := stateOf(t, s, w1, sid); st != nil {
		t.Fatalf("ghost state in the workspace after its participant_left: %+v", st)
	}
	if w, r, ok := location(); !ok || w != dm || r != dm {
		t.Fatalf("location after the old room's leave: %v %v %v, want the DM", w, r, ok)
	}

	// DM call → workspace room; the call's session ends after the device joined the room.
	setState(t, s, w1, u, sid, a, 0)
	dmDrop(dm)
	if st := stateOf(t, s, dm, sid); st != nil {
		t.Fatalf("ghost state in the DM: %+v", st)
	}
	if w, r, ok := location(); !ok || w != w1 || r != a {
		t.Fatalf("location after the call's end: %v %v %v, want the workspace room", w, r, ok)
	}

	// Workspace → another workspace, the same way.
	w2, b := uuid.New(), uuid.New()
	setState(t, s, w2, u, sid, b, 0)
	left(w1, a)
	if st := stateOf(t, s, w1, sid); st != nil {
		t.Fatalf("ghost state in the first workspace: %+v", st)
	}
	if w, r, ok := location(); !ok || w != w2 || r != b {
		t.Fatalf("location after the first workspace's leave: %v %v %v, want the second", w, r, ok)
	}

	// Leaving the current scope clears the location: nothing is left anywhere.
	left(w2, b)
	if _, _, ok := location(); ok {
		t.Fatal("location kept after leaving the current room")
	}
	for _, w := range []uuid.UUID{w1, w2, dm} {
		if st := stateOf(t, s, w, sid); st != nil {
			t.Fatalf("state left in scope %v: %+v", w, st)
		}
	}
}
