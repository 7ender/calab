//go:build integration

package rtc

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/voice"
)

func leaveReq(t *testing.T, s *Service, uid, sid, rid uuid.UUID) {
	t.Helper()
	ctx := auth.WithIdentity(context.Background(), auth.Identity{UserID: uid, SessionID: sid})
	r := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/rooms/"+rid.String()+"/voice/leave", nil)
	r.SetPathValue("id", rid.String())
	w := httptest.NewRecorder()
	httpx.HandlerFunc(s.leave).ServeHTTP(w, r)
	if w.Code != http.StatusNoContent {
		t.Fatalf("leave: %d %s", w.Code, w.Body)
	}
}

// POST /voice/leave (docs/05): a pending device is removed at once and its connect
// confirmation disarmed; a connected one is also removed from LiveKit (the app test covers
// repeated leaves and a late leave after a newer /join).
func TestVoiceLeave(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	ctx := context.Background()
	wid, rid := uuid.New(), uuid.New()
	room := wsRoom{Room: sqlc.Room{ID: rid}, WorkspaceID: wid}
	lkRoom := voice.RoomName(wid, rid)
	u, sid := uuid.New(), uuid.New()

	// Pending → leave: state gone, the 15 s wait cancelled.
	_, joined, err := s.recordPending(ctx, room, u, sid, admission{})
	if err != nil {
		t.Fatal(err)
	}
	s.expectConnect(wid, rid, u, sid, joined)
	w, _ := s.waits.Load(sid)
	leaveReq(t, s, u, sid, rid)
	if st := stateOf(t, s, wid, sid); st != nil {
		t.Fatalf("pending state kept after leave: %+v", st)
	}
	if _, armed := s.waits.Load(sid); armed || w.(*connectWait).t.Stop() {
		t.Fatal("connect confirmation still armed after leave")
	}

	// Connected → leave: removed from LiveKit and from the room.
	if _, _, err := s.recordPending(ctx, room, u, sid, admission{}); err != nil {
		t.Fatal(err)
	}
	if err := s.setFlag(ctx, wid, rid, u, sid, func(n *voice.SessionState) { n.Pending = false }); err != nil {
		t.Fatal(err)
	}
	lk.rooms[lkRoom] = []Participant{{Identity: voice.Identity(u, sid)}}
	leaveReq(t, s, u, sid, rid)
	if !lk.wasRemoved(lkRoom, voice.Identity(u, sid)) {
		t.Fatal("connected device not removed from LiveKit")
	}
	if st := stateOf(t, s, wid, sid); st != nil {
		t.Fatalf("connected state kept after leave: %+v", st)
	}
}

// The call timer (voice:started) starts with the first connected device, not with a pending
// /join; a pending join rolled back leaves no call behind.
func TestCallStartsOnConnect(t *testing.T) {
	lk := presenceLK{&fakeLK{rooms: map[string][]Participant{}}}
	s, _ := testService(t, lk)
	ctx := context.Background()
	wid, rid := uuid.New(), uuid.New()
	room := wsRoom{Room: sqlc.Room{ID: rid}, WorkspaceID: wid}
	started := func() (int64, bool) {
		m, err := s.voice.StartedAt(ctx, []uuid.UUID{rid})
		if err != nil {
			t.Fatal(err)
		}
		at, ok := m[rid]
		return at.UnixMilli(), ok
	}

	// Pending join, never connected: no call, before and after the rollback.
	a, as := uuid.New(), uuid.New()
	_, aj, err := s.recordPending(ctx, room, a, as, admission{})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := started(); ok {
		t.Fatal("a pending join started the call")
	}
	s.confirmConnect(wid, rid, a, as, aj)
	if _, ok := started(); ok {
		t.Fatal("rolled-back pending join left a call")
	}

	// Pending, then connected: the call starts at the connect.
	b, bs := uuid.New(), uuid.New()
	_, bj, err := s.recordPending(ctx, room, b, bs, admission{})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.voice.Update(ctx, wid, b, bs, func(cur *voice.SessionState) *voice.SessionState {
		n := *cur
		n.Pending = false
		return &n
	})
	if err != nil {
		t.Fatal(err)
	}
	at, ok := started()
	if !ok || at < bj || len(c.Calls) != 1 {
		t.Fatalf("call start %d (ok=%v, calls %v), pending since %d", at, ok, c.Calls, bj)
	}
	// Another pending device does not move it; the connected one leaving ends the call.
	if _, _, err := s.recordPending(ctx, room, uuid.New(), uuid.New(), admission{}); err != nil {
		t.Fatal(err)
	}
	if at2, _ := started(); at2 != at {
		t.Fatalf("pending join moved the call start: %d → %d", at, at2)
	}
	leaveReq(t, s, b, bs, rid)
	if _, ok := started(); ok {
		t.Fatal("call kept with only a pending device left")
	}
}
