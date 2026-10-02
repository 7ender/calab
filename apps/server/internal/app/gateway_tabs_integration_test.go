//go:build integration

package app_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// identifyTab sends IDENTIFY with a tab id (#40) and waits for READY.
func (g *gw) identifyTab(token, tab string) *v1.Ready {
	g.t.Helper()
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{Token: token, TabId: tab}}})
	return g.wait("READY", func(e *v1.DispatchEvent) bool { return e.GetReady() != nil }).GetReady()
}

func isMessage(id string) func(*v1.DispatchEvent) bool {
	return func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == id }
}

// Two tabs of one auth session (#40): both keep their gateway sessions and both get events;
// only the same tab replaces its own session; desktop (no tab id) keeps one session per auth
// session; a revocation closes every tab.
func TestGatewayTabsOfOneSession(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "tabs"}, &tr)
	room := tr.GetRoom().GetId()

	a, b := dialGW(t), dialGW(t)
	ra := a.identifyTab(bob.token, "tab-a")
	rb := b.identifyTab(bob.token, "tab-b")
	if ra.GetSessionId() == rb.GetSessionId() {
		t.Fatal("two tabs share a gateway session")
	}
	// No eviction: both sockets stay open and both receive the same event.
	m := send(t, o, room, "hello tabs", uniq("n"))
	a.wait("MESSAGE_CREATE in tab a", isMessage(m.GetId()))
	b.wait("MESSAGE_CREATE in tab b", isMessage(m.GetId()))

	// Tab a reloads (same tab id, new IDENTIFY): only its own old session is replaced.
	a2 := dialGW(t)
	a2.identifyTab(bob.token, "tab-a")
	if st, reason := a.closeFrame(); st != 4000 || reason != "replaced by a new session" {
		t.Fatalf("old tab a: close %d %q, want 4000 replaced", st, reason)
	}
	m = send(t, o, room, "after reload", uniq("n"))
	a2.wait("MESSAGE_CREATE in reloaded tab a", isMessage(m.GetId()))
	b.wait("MESSAGE_CREATE in tab b after a's reload", isMessage(m.GetId()))

	// A RESUME of tab b keeps it (and does not disturb tab a).
	b2 := dialGW(t)
	b2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{Token: bob.token, SessionId: rb.GetSessionId(), Seq: b.last}}})
	b2.wait("RESUMED", func(e *v1.DispatchEvent) bool { return e.GetResumed() != nil })
	m = send(t, o, room, "after resume", uniq("n"))
	a2.wait("MESSAGE_CREATE in tab a after b's resume", isMessage(m.GetId()))
	b2.wait("MESSAGE_CREATE in resumed tab b", isMessage(m.GetId()))

	// Logout revokes the auth session: every tab is closed with 4010.
	bob.must(204, "POST", "/api/auth/logout", &v1.LogoutRequest{}, nil)
	for i, g := range []*gw{a2, b2} {
		if st, reason := g.closeFrame(); st != 4010 || reason != "session revoked: LOGOUT" {
			t.Fatalf("tab %d after logout: close %d %q, want 4010", i, st, reason)
		}
	}
}

// Desktop and bots send no tab id: a new IDENTIFY replaces the device's previous session.
func TestGatewayNoTabReplacesDevice(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	first := dialGW(t)
	first.identify(u.token)
	second := dialGW(t)
	second.identify(u.token)
	if st, reason := first.closeFrame(); st != 4000 || reason != "replaced by a new session" {
		t.Fatalf("first desktop session: close %d %q, want 4000 replaced", st, reason)
	}
	// A tab of the same auth session coexists with the desktop-style session.
	tab := dialGW(t)
	tab.identifyTab(u.token, "web-1")
	time.Sleep(200 * time.Millisecond)
	second.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{LastSeq: second.last}}})
	second.waitFrame("HEARTBEAT_ACK on the desktop session", func(f *v1.GatewayFrame) bool { return f.GetHeartbeatAck() != nil })
	_ = second.ws.Close(websocket.StatusNormalClosure, "")
	_ = tab.ws.Close(websocket.StatusNormalClosure, "")
}

// Above the cap (8 tabs per auth session) the tab claimed longest ago is evicted with 4011,
// once: the others stay, and tabs count as one device toward the per-user limit.
func TestGatewayTabCapEvictsOldest(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	tabs := make([]*gw, 0, 9)
	for i := range 9 {
		g := dialGW(t)
		g.identifyTab(u.token, fmt.Sprintf("t%d", i))
		tabs = append(tabs, g)
		time.Sleep(2 * time.Millisecond) // distinct claim times
	}
	if st, reason := tabs[0].closeFrame(); st != 4011 || reason != "evicted by a newer tab" {
		t.Fatalf("oldest tab: close %d %q, want 4011", st, reason)
	}
	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "cap"}, &tr)
	m := send(t, o, tr.GetRoom().GetId(), "still here", uniq("n"))
	for i, g := range tabs[1:] {
		g.wait(fmt.Sprintf("MESSAGE_CREATE in tab %d", i+1), isMessage(m.GetId()))
	}
	for _, g := range tabs[1:] {
		_ = g.ws.Close(websocket.StatusNormalClosure, "")
	}
}

// Voice belongs to the auth session, not to a tab: both tabs get the same LiveKit identity, so
// LiveKit keeps one participant (the other tab leaves with DUPLICATE_IDENTITY), and a join
// from the same auth session never takes the other tab out with VOICE_DISCONNECTED.
func TestGatewayTabsShareVoiceIdentity(t *testing.T) {
	liveKitUp(t)
	_, bob, _, room := setupTeam(t)
	a, b := dialGW(t), dialGW(t)
	a.identifyTab(bob.token, "va")
	b.identifyTab(bob.token, "vb")
	var j1, j2 v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+room.GetId()+"/join", nil, &j1)
	bob.must(200, "POST", "/api/rooms/"+room.GetId()+"/join", nil, &j2)
	if want := bob.id + ":" + bob.session; j1.GetIdentity() != want || j2.GetIdentity() != want {
		t.Fatalf("identities %q / %q, want %q for both tabs", j1.GetIdentity(), j2.GetIdentity(), want)
	}
	noDisconnect := func(e *v1.DispatchEvent) bool { return e.GetVoiceDisconnected() != nil }
	a.quiet("VOICE_DISCONNECTED in tab a", 300*time.Millisecond, noDisconnect)
	b.quiet("VOICE_DISCONNECTED in tab b", 100*time.Millisecond, noDisconnect)
	bob.must(204, "POST", "/api/rooms/"+room.GetId()+"/voice/leave", nil, nil)
	_ = a.ws.Close(websocket.StatusNormalClosure, "")
	_ = b.ws.Close(websocket.StatusNormalClosure, "")
}
