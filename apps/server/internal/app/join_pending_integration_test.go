//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Optimistic voice join (docs/05, docs/09 P1 #8) against the dev LiveKit: /join records the
// device as pending and everyone sees it at once; participant_joined clears pending; a
// device that never connects is removed after 15 s; pending devices count toward user_limit;
// a repeated /join is idempotent.
func TestOptimisticJoin(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	carl := register(t, invite(t, o, ws.GetId()))
	wid, rid := ws.GetId(), room.GetId()
	duo := voiceRoom(t, o, wid, "duo", 1)
	bg := dialGW(t)
	bg.identify(bob.token)
	stateOf := func(uid, roomID string, pending bool) func(*v1.DispatchEvent) bool {
		return func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return e.GetVoiceStateUpdate() != nil && s.GetUserId() == uid && s.GetRoomId() == roomID && s.GetPending() == pending
		}
	}

	// Join: the owner is in the room for everybody before any LiveKit connection.
	var j v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	if !j.GetPending() || j.GetToken() == "" {
		t.Fatalf("join response: pending=%v token=%q", j.GetPending(), j.GetToken())
	}
	bg.wait("owner pending in the room", stateOf(o.id, rid, true))
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, j.GetIdentity(), nil), "secret")
	bg.wait("owner connected", stateOf(o.id, rid, false))
	var again v1.JoinVoiceResponse
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &again)
	if again.GetPending() {
		t.Fatal("repeated /join of a connected device made it pending again")
	}

	// Carl takes the only place of «duo» while still connecting: bob is refused.
	var cj v1.JoinVoiceResponse
	carl.must(200, "POST", "/api/rooms/"+duo+"/join", nil, &cj)
	joined := time.Now()
	bg.wait("carl pending in duo", stateOf(carl.id, duo, true))
	carl.must(200, "POST", "/api/rooms/"+duo+"/join", nil, &cj) // idempotent: still one place
	if !cj.GetPending() {
		t.Fatal("repeated /join of a pending device: pending=false")
	}
	if raw := bob.rawErr("POST", "/api/rooms/"+duo+"/join"); raw.GetCode() != v1.ErrorCode_ERROR_CODE_ROOM_FULL {
		t.Fatalf("pending user not counted in user_limit: %v", raw.GetCode())
	}

	// Carl never connects: rolled back after 15 s; the owner (connected) stays.
	time.Sleep(time.Until(joined.Add(14500 * time.Millisecond)))
	bg.wait("carl rolled back", stateOf(carl.id, "", false))
	if el := time.Since(joined); el < 14*time.Second {
		t.Fatalf("rolled back too early: %v", el)
	}
	for _, s := range dialGW(t).identify(carl.token).GetWorkspaces() {
		for _, vs := range s.GetVoiceStates() {
			if vs.GetUserId() == o.id && (vs.GetRoomId() != rid || vs.GetPending()) {
				t.Fatalf("connected owner touched by the rollback: %v", vs)
			}
			if vs.GetUserId() == carl.id {
				t.Fatalf("carl still in voice: %v", vs)
			}
		}
	}
	bob.must(200, "POST", "/api/rooms/"+duo+"/join", nil, nil) // the place is free again
}
