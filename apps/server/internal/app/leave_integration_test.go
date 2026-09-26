//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// connectConfirmWait outlasts the server's 15 s connect confirmation.
const connectConfirmWait = 16 * time.Second

// POST /voice/leave (docs/05): «Отключиться» before LiveKit connected takes the device out
// for everybody at once (no 15 s pending), the connect confirmation does not fire later, a
// pending join makes no call (voice_started_at); a late leave of an old room keeps a newer
// /join; a connected device leaving ends the call. Idempotent (204).
func TestVoiceLeave(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	other := voiceRoom(t, o, wid, "other", 0)
	bg := dialGW(t)
	bg.identify(bob.token)
	owner := func(roomID string, pending bool) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return e.GetVoiceStateUpdate() != nil && s.GetUserId() == o.id && s.GetRoomId() == roomID && s.GetPending() == pending
		}
	}
	leave := func(roomID string) { o.must(204, "POST", "/api/rooms/"+roomID+"/voice/leave", nil, nil) }

	// Pending → leave: gone for bob right away.
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	bg.wait("owner pending", owner(rid, true))
	began := time.Now()
	leave(rid)
	bg.wait("owner left", owner("", false))
	if el := time.Since(began); el > 2*time.Second {
		t.Fatalf("leave took %v", el)
	}
	leave(rid) // idempotent
	// Nothing more about the owner when the 15 s confirmation would have run, and no call.
	bg.quiet("event after leave", connectConfirmWait, func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return e.GetVoiceStateUpdate().GetState().GetUserId() == o.id || (r.GetId() == rid && r.GetVoiceStartedAt() != nil)
	})

	// A late leave of the old room does not undo the /join into the other room.
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	o.must(200, "POST", "/api/rooms/"+other+"/join", nil, nil)
	bg.wait("owner pending in other", owner(other, true))
	leave(rid)
	bg.quiet("late leave touched the newer join", 500*time.Millisecond, func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == o.id && s.GetRoomId() != other
	})
	leave(other)
	bg.wait("owner left other", owner("", false))

	// Connected → leave: the call starts at the connect and ends with the leave.
	var j v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	bg.wait("owner pending again", owner(rid, true))
	time.Sleep(50 * time.Millisecond)
	connected := time.Now()
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, j.GetIdentity(), nil), "secret")
	e := bg.wait("call started", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetVoiceStartedAt() != nil
	})
	if st := e.GetRoomUpdate().GetRoom().GetVoiceStartedAt().AsTime(); st.Before(connected.Add(-10 * time.Millisecond)) {
		t.Fatalf("call start %v before the connect %v", st, connected)
	}
	leave(rid)
	bg.wait("call ended", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetVoiceStartedAt() == nil
	})
}
