package voice

import (
	"testing"

	"github.com/google/uuid"
)

func TestAggregate(t *testing.T) {
	ws, u, other := uuid.New(), uuid.New(), uuid.New()
	r1, r2 := uuid.New(), uuid.New()
	s1, s2, s3 := uuid.New(), uuid.New(), uuid.New()

	if st := Aggregate(ws, u, nil); st.GetRoomId() != "" || st.GetUserId() != u.String() {
		t.Fatalf("absent user: %v", st)
	}
	sessions := []SessionState{
		{UserID: u, SessionID: s1, RoomID: r1, Muted: true, Deafened: false, JoinedAt: 100},
		{UserID: u, SessionID: s2, RoomID: r1, Muted: false, Streaming: true, JoinedAt: 200},
		{UserID: other, SessionID: s3, RoomID: r2, Muted: true, JoinedAt: 300},
	}
	st := Aggregate(ws, u, sessions)
	if st.GetRoomId() != r1.String() || st.GetMuted() || st.GetDeafened() || !st.GetStreaming() {
		t.Fatalf("two devices in one room: %v", st)
	}
	sessions[1].Muted = true
	if st := Aggregate(ws, u, sessions); !st.GetMuted() {
		t.Fatal("muted must be true when all sessions are muted")
	}
	// A newer session in another room wins; flags come from that room only.
	sessions = append(sessions, SessionState{UserID: u, SessionID: uuid.New(), RoomID: r2, JoinedAt: 500})
	if st := Aggregate(ws, u, sessions); st.GetRoomId() != r2.String() || st.GetStreaming() || st.GetMuted() {
		t.Fatalf("latest room: %v", st)
	}
	all := AggregateAll(ws, sessions)
	if len(all) != 2 {
		t.Fatalf("AggregateAll: %d users", len(all))
	}
}

func TestNames(t *testing.T) {
	w, r, u, s := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	gw, gr, ok := ParseRoomName(RoomName(w, r))
	if !ok || gw != w || gr != r {
		t.Fatal("room name round trip")
	}
	gu, gs, ok := ParseIdentity(Identity(u, s))
	if !ok || gu != u || gs != s {
		t.Fatal("identity round trip")
	}
	for _, bad := range []string{"", "ws_x_room_y", "room", "ws_" + w.String()} {
		if _, _, ok := ParseRoomName(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
	if _, _, ok := ParseIdentity("abc"); ok {
		t.Error("bad identity parsed")
	}
}
