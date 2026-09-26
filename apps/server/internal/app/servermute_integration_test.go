//go:build integration

package app_test

import (
	"slices"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/rtc"
)

func TestServerMute(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	g := dialGW(t)
	g.identify(o.token)
	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "secret")
	g.wait("bob in voice", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetUserId() == bob.id })
	hasMic := func() bool {
		p, ok := lkRec.lastPerm(j.GetIdentity())
		return ok && slices.Contains(p.CanPublishSources, rtc.SourceMicrophone)
	}
	serverMuted := func(want bool) {
		t.Helper()
		g.wait("VOICE_STATE_UPDATE server_muted", func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return s.GetUserId() == bob.id && s.GetServerMuted() == want
		})
	}

	// Only MUTE_MEMBERS can mute and unmute; the member cannot lift it.
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+o.id+"/mute", nil, nil)
	// MUTE_MEMBERS in one room (override) is not enough: the mute covers the workspace (L3).
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: bob.id, Allow: 128},
	}}, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/mute", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/mute", nil, nil)
	serverMuted(true)
	if hasMic() {
		t.Fatal("server-muted grant still allows the microphone")
	}
	bob.must(403, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/unmute", nil, nil)
	unmute := false
	bob.must(403, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Muted: &unmute}, nil)

	// A microphone published unmuted (token issued before the mute) is muted again.
	webhook(t, whEvent("track_published", roomName, j.GetIdentity(), &livekit.TrackInfo{Sid: "TR_mic", Source: livekit.TrackSource_MICROPHONE}), "secret")
	deadline := time.Now().Add(3 * time.Second)
	for !slices.Contains(lkRec.mutedTracks(), j.GetIdentity()+"/TR_mic") {
		if time.Now().After(deadline) {
			t.Fatal("microphone of a server-muted user was not muted")
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Kept across devices and rejoins: READY and a new join.
	found := false
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() { // not o: that would replace g
		for _, vs := range s.GetVoiceStates() {
			found = found || (vs.GetUserId() == bob.id && vs.GetServerMuted() && vs.GetMuted())
		}
	}
	if !found {
		t.Fatal("READY lacks server_muted")
	}
	webhook(t, whEvent("participant_left", roomName, j.GetIdentity(), nil), "secret")
	g.wait("bob left", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == ""
	})
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	if j.GetCanSpeak() {
		t.Fatal("rejoin of a server-muted user: can_speak")
	}
	webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "secret")
	g.wait("bob back", func(e *v1.DispatchEvent) bool {
		s := e.GetVoiceStateUpdate().GetState()
		return s.GetUserId() == bob.id && s.GetRoomId() == rid && s.GetServerMuted()
	})

	o.must(204, "POST", "/api/rooms/"+rid+"/voice/"+bob.id+"/unmute", nil, nil)
	serverMuted(false)
	if !hasMic() {
		t.Fatal("unmute did not restore the microphone grant")
	}
	bob.must(204, "PATCH", "/api/voice/self", &v1.UpdateVoiceSelfRequest{Muted: &unmute}, nil)
}
