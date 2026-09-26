//go:build integration

package app_test

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestEmbedsHidden(t *testing.T) {
	o, bob, _, room := setupTeam(t)
	rid := room.GetId()
	g := dialGW(t)
	g.identify(bob.token)
	m := send(t, o, rid, "see https://example.com", "")
	path := "/api/messages/" + m.GetId() + "/embeds-hidden"
	bob.must(403, "PUT", path, &v1.SetEmbedsHiddenRequest{Hidden: true}, nil) // not the author, no MANAGE_MESSAGES
	var resp v1.UpdateMessageResponse
	o.must(200, "PUT", path, &v1.SetEmbedsHiddenRequest{Hidden: true}, &resp)
	if !resp.GetMessage().GetEmbedsHidden() || resp.GetMessage().GetEditedAt() != nil {
		t.Fatalf("response: %v", resp.GetMessage())
	}
	g.wait("MESSAGE_UPDATE embeds hidden", func(e *v1.DispatchEvent) bool {
		u := e.GetMessageUpdate().GetMessage()
		return u.GetId() == m.GetId() && u.GetEmbedsHidden()
	})
	var list v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &list)
	found := false
	for _, x := range list.GetMessages() {
		found = found || (x.GetId() == m.GetId() && x.GetEmbedsHidden())
	}
	if !found {
		t.Fatal("history lacks embeds_hidden")
	}
	o.must(200, "PUT", path, &v1.SetEmbedsHiddenRequest{Hidden: false}, &resp)
	if resp.GetMessage().GetEmbedsHidden() {
		t.Fatal("not shown again")
	}
}

func TestVoiceStatus(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	g := dialGW(t)
	g.identify(o.token)
	path := "/api/rooms/" + rid + "/voice-status"
	bob.must(403, "PATCH", path, &v1.UpdateVoiceStatusRequest{Status: "Планёрка"}, nil) // not in the call

	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", roomName, j.GetIdentity(), nil), "secret")
	g.wait("bob in voice", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetRoomId() == rid })
	bob.must(422, "PATCH", path, &v1.UpdateVoiceStatusRequest{Status: strings.Repeat("я", 61)}, nil)
	var resp v1.UpdateRoomResponse
	bob.must(200, "PATCH", path, &v1.UpdateVoiceStatusRequest{Status: "  Планёрка  "}, &resp)
	if resp.GetRoom().GetVoiceStatus() != "Планёрка" || resp.GetRoom().GetVoiceStartedAt() == nil {
		t.Fatalf("response: %v", resp.GetRoom())
	}
	g.wait("ROOM_UPDATE voice status", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetVoiceStatus() == "Планёрка" && r.GetVoiceStartedAt() != nil
	})
	var text v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "text"}, &text)
	o.must(422, "PATCH", "/api/rooms/"+text.GetRoom().GetId()+"/voice-status", &v1.UpdateVoiceStatusRequest{Status: "x"}, nil)

	// The last participant leaves: the status is cleared with the call (one ROOM_UPDATE).
	webhook(t, whEvent("participant_left", roomName, j.GetIdentity(), nil), "secret")
	g.wait("ROOM_UPDATE call ended, status cleared", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetVoiceStartedAt() == nil && r.GetVoiceStatus() == ""
	})
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		for _, r := range s.GetRooms() {
			if r.GetId() == rid && r.GetVoiceStatus() != "" {
				t.Fatal("READY still has the status")
			}
		}
	}
	// MANAGE_ROOM may set it without being in the call.
	o.must(200, "PATCH", path, &v1.UpdateVoiceStatusRequest{Status: "Скоро созвон"}, nil)
	o.must(200, "PATCH", path, &v1.UpdateVoiceStatusRequest{Status: ""}, &resp)
	if resp.GetRoom().GetVoiceStatus() != "" {
		t.Fatal("empty status must clear")
	}
}
