//go:build integration

package rtc

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/voice"
)

// These tests need Redis (voice state, locks) but no Postgres or LiveKit: LiveKit is faked.
// They use Redis DB 14 so that Reconcile never sees the voice state of internal/app's tests,
// which may run in parallel on DB 15.

type fakeLK struct {
	LiveKit // unused methods panic (nil)
	mu      sync.Mutex
	rooms   map[string][]Participant // LiveKit room name -> participants
	removed []string                 // "room/identity"
}

func (f *fakeLK) ListRooms(context.Context) ([]Room, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Room, 0, len(f.rooms))
	for name := range f.rooms {
		out = append(out, Room{Name: name})
	}
	return out, nil
}

func (f *fakeLK) ListParticipants(_ context.Context, room string) ([]Participant, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Participant(nil), f.rooms[room]...), nil
}

func (f *fakeLK) RemoveParticipant(_ context.Context, room, identity string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, room+"/"+identity)
	return nil
}

func (f *fakeLK) wasRemoved(room, identity string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.removed {
		if r == room+"/"+identity {
			return true
		}
	}
	return false
}

func testService(t *testing.T, lk LiveKit) (*Service, rueidis.Client) {
	t.Helper()
	url := os.Getenv("TEST_REDIS_URL")
	if url == "" {
		t.Skip("TEST_REDIS_URL not set")
	}
	opt, err := rueidis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	opt.SelectDB = 14
	rc, err := rueidis.NewClient(opt)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rc.Close)
	if err := rc.Do(context.Background(), rc.B().Flushdb().Build()).Error(); err != nil {
		t.Fatal(err)
	}
	s := NewService(Config{}, nil, rc, lk, events.Nop{})
	s.voice.OnCalls = nil // call-start announcements need Postgres; not under test here
	return s, rc
}

// setState records a device in a room with the given join time (0 = now).
func setState(t *testing.T, s *Service, wid, uid, sid, rid uuid.UUID, joinedAt int64) {
	t.Helper()
	if _, err := s.voice.Update(context.Background(), wid, uid, sid, func(*voice.SessionState) *voice.SessionState {
		return &voice.SessionState{RoomID: rid, JoinedAt: joinedAt}
	}); err != nil {
		t.Fatal(err)
	}
}

func roomOf(t *testing.T, s *Service, wid, sid uuid.UUID) uuid.UUID {
	t.Helper()
	states, err := s.voice.List(context.Background(), wid)
	if err != nil {
		t.Fatal(err)
	}
	for _, st := range states {
		if st.SessionID == sid {
			return st.RoomID
		}
	}
	return uuid.Nil
}

// Bug 2: the 5 s drop after an app-level move must not remove a device that is back in the
// old room by then (moved back, or rejoined it itself); a device still recorded in the
// target is removed from the old room.
func TestDropFromOldRoomSparesReturnedDevice(t *testing.T) {
	lk := &fakeLK{}
	s, _ := testService(t, lk)
	wid, src, dst, uid, sid := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	identity, srcName := voice.Identity(uid, sid), voice.RoomName(wid, src)

	setState(t, s, wid, uid, sid, src, 0) // back in the old room
	s.dropFromOldRoom(src, sid, srcName, identity)
	if lk.wasRemoved(srcName, identity) {
		t.Fatal("device that is back in the old room was removed from it")
	}

	setState(t, s, wid, uid, sid, dst, 0) // still recorded in the target: drop it from the old room
	s.dropFromOldRoom(src, sid, srcName, identity)
	if !lk.wasRemoved(srcName, identity) {
		t.Fatal("moved device was not removed from the old room")
	}
}

// Bug 3: while an app-level-moved device is still connected to the old room for a moment,
// Reconcile must not flip its fresh target-room state back to the old room. A stale state
// (older than joinGrace) is still corrected to where LiveKit sees the device.
func TestReconcileKeepsFreshMove(t *testing.T) {
	wid, src, dst := uuid.New(), uuid.New(), uuid.New()
	fresh := struct{ uid, sid uuid.UUID }{uuid.New(), uuid.New()}
	stale := struct{ uid, sid uuid.UUID }{uuid.New(), uuid.New()}
	lk := &fakeLK{rooms: map[string][]Participant{
		voice.RoomName(wid, src): {
			{Identity: voice.Identity(fresh.uid, fresh.sid)},
			{Identity: voice.Identity(stale.uid, stale.sid)},
		},
	}}
	s, _ := testService(t, lk)
	setState(t, s, wid, fresh.uid, fresh.sid, dst, 0)                                        // just moved
	setState(t, s, wid, stale.uid, stale.sid, dst, time.Now().Add(-2*joinGrace).UnixMilli()) // long ago

	if err := s.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := roomOf(t, s, wid, stale.sid); got != src {
		t.Fatalf("control: stale state not corrected by Reconcile (room %v, want src)", got)
	}
	if got := roomOf(t, s, wid, fresh.sid); got != dst {
		t.Fatalf("fresh move flipped back by Reconcile (room %v, want dst)", got)
	}
}
