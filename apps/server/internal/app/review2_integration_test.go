//go:build integration

package app_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
	"github.com/calaba/calaba/server/internal/redisx"
)

// R1: RESUME on the same hub while events keep flowing: replayed and live frames arrive in
// strictly increasing, contiguous seq order and every event exactly once.
func TestLocalResumeOrdering(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	g := dialGW(t)
	ready := g.identify(bob.token)
	for round := range 6 { // the race window is milliseconds: repeat to hit it reliably
		g = resumeUnderLoad(t, o, bob, ws.GetId(), ready.GetSessionId(), g, round)
	}
}

func resumeUnderLoad(t *testing.T, o, bob *user, wsID, sessionID string, g *gw, round int) *gw {
	t.Helper()
	ws := &v1.Workspace{Id: wsID}
	ready := &v1.Ready{SessionId: sessionID}
	last := g.last
	_ = g.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)

	const n = 40
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // a burst of workspace updates straddling the RESUME
		defer wg.Done()
		for i := range n {
			name := fmt.Sprintf("Team %d-%d", round, i)
			o.must(200, "PATCH", "/api/workspaces/"+ws.GetId(), &v1.UpdateWorkspaceRequest{Name: &name}, nil)
		}
	}()
	time.Sleep(30 * time.Millisecond)
	g2 := dialGW(t)
	g2.last = last
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: last}}})
	seen := map[string]int{}
	expect := last + 1
	deadline := time.Now().Add(10 * time.Second)
	for len(seen) < n && time.Now().Before(deadline) {
		f, err := g2.read(time.Until(deadline))
		if err != nil {
			t.Fatalf("after %d updates: %v", len(seen), err)
		}
		if f.GetSeq() == 0 {
			continue
		}
		if f.GetSeq() != expect {
			t.Fatalf("seq %d, want %d (gap or reorder)", f.GetSeq(), expect)
		}
		expect++
		if u := f.GetDispatch().GetWorkspaceUpdate(); u != nil {
			seen[u.GetWorkspace().GetName()]++
		}
	}
	wg.Wait()
	if len(seen) != n {
		t.Fatalf("received %d of %d updates", len(seen), n)
	}
	for name, c := range seen {
		if c != 1 {
			t.Fatalf("%s delivered %d times", name, c)
		}
	}
	return g2
}

// R4: a failed local RESUME delivers INVALID_SESSION on the same socket (not a close).
func TestLocalResumeInvalidFirst(t *testing.T) {
	_, bob, _, _ := setupTeam(t)
	g := dialGW(t)
	ready := g.identify(bob.token)
	_ = g.ws.CloseNow()
	time.Sleep(100 * time.Millisecond)
	g2 := dialGW(t)
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: g.last + 1000}}}) // seq we never sent
	f := g2.waitFrame("INVALID_SESSION", func(f *v1.GatewayFrame) bool { return f.GetInvalidSession() != nil })
	if f.GetInvalidSession().GetResumable() {
		t.Fatal("resumable")
	}
	g2.identify(bob.token) // the socket is still usable
}

// R2: an owner that no longer has the session must not confirm a release.
func TestReleaseNotConfirmedForGoneSession(t *testing.T) {
	_, bob, _, _ := setupTeam(t)
	a, b := newInstance(t), newInstance(t)
	g := dialAt(t, a.srv.URL)
	ready := g.identify(bob.token)
	owner, _ := testRedis.Do(context.Background(), testRedis.B().Hget().Key(redisx.Key("gw:sess:"+ready.GetSessionId())).Field("owner").Build()).ToString()
	a.app.Gateway.Shutdown(context.Background())
	// Simulate the race of review R2: the owner field still names A (alive) after its release.
	_ = testRedis.Do(context.Background(), testRedis.B().Hset().Key(redisx.Key("gw:sess:"+ready.GetSessionId())).FieldValue().FieldValue("owner", owner).Build()).Error()
	g2 := dialAt(t, b.srv.URL)
	g2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_RESUME, Payload: &v1.GatewayFrame_Resume{Resume: &v1.Resume{
		Token: bob.token, SessionId: ready.GetSessionId(), Seq: g.last}}})
	f := g2.waitFrame("INVALID_SESSION", func(f *v1.GatewayFrame) bool {
		return f.GetInvalidSession() != nil || f.GetDispatch().GetResumed() != nil
	})
	if f.GetInvalidSession() == nil {
		t.Fatal("RESUME confirmed by an owner that had already released the session")
	}
}

// R3: an admin moves a member into a full room; the target's participant_joined keeps them.
func TestAdminMoveIntoFullRoom(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, roomA := setupTeam(t)
	wid := ws.GetId()
	full := voiceRoom(t, o, wid, "Full", 1)
	alice := register(t, invite(t, o, wid))
	lkRec.mu.Lock()
	lkRec.fakeMove = true
	lkRec.mu.Unlock()
	testApp.RTC.SetSFUMove(true) // fakeMove stands for a LiveKit with MoveParticipant
	defer func() { lkRec.mu.Lock(); lkRec.fakeMove = false; lkRec.mu.Unlock() }()
	joinVoice(t, alice, wid, full)
	bi := joinVoice(t, bob, wid, roomA.GetId())
	o.must(204, "POST", "/api/rooms/"+roomA.GetId()+"/voice/"+bob.id+"/move", &v1.MoveMemberRequest{TargetRoomId: full}, nil)
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+full, bi, nil), "secret") // LiveKit's view of the move
	time.Sleep(50 * time.Millisecond)
	if lkRec.wasRemoved(bi) || !inVoice(t, o, bob.id, full) {
		t.Fatal("moved member was evicted from the full room by join revalidation")
	}
}

// R7: fast room switching (many SUBSCRIBE / TYPING) is dropped, not disconnected.
// R8: a guest gets MEMBER_ADD when a member becomes visible through a shared room.
func TestSoftLimitAndGuestMemberAdd(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	g := dialGW(t)
	g.identify(bob.token)
	for range 40 {
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_SUBSCRIBE, Payload: &v1.GatewayFrame_Subscribe{Subscribe: &v1.Subscribe{RoomIds: []string{rid}}}})
	}
	g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_HEARTBEAT, Payload: &v1.GatewayFrame_Heartbeat{Heartbeat: &v1.Heartbeat{}}})
	g.waitFrame("HEARTBEAT_ACK after a SUBSCRIBE burst", func(f *v1.GatewayFrame) bool { return f.GetHeartbeatAck() != nil })

	// A member hidden from the guest's room becomes visible → the guest gets MEMBER_ADD.
	hermit := register(t, invite(t, o, wid))
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: hermit.id, Deny: uint64(perm.ViewRoom)},
	}}, nil)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.90.0.1"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "G"}, &gj)
	gg := dialGW(t)
	gg.identify(gj.GetTokens().GetAccessToken())
	cur := cloneOverrides(t, o, rid)
	var kept []*v1.RoomPermissionOverride
	for _, ov := range cur {
		if ov.GetTargetId() != hermit.id {
			kept = append(kept, ov)
		}
	}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: kept}, nil)
	gg.wait("synthetic MEMBER_ADD", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberAdd().GetMember().GetUser().GetId() == hermit.id
	})
	// And MEMBER_REMOVE when they become hidden again.
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: append(kept, &v1.RoomPermissionOverride{
		TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: hermit.id, Deny: uint64(perm.ViewRoom)})}, nil)
	gg.wait("synthetic MEMBER_REMOVE", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberRemove().GetUserId() == hermit.id
	})
}
