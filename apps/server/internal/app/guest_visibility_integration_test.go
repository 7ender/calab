//go:build integration

// What a guest sees of the workspace (ADR-0016 amendment, owner report 02.10): the people of its
// rooms, never the member directory — even in a room open to every member.
package app_test

import (
	"net/url"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// guestSnapshot returns the guest's READY snapshot of workspace wid.
func guestSnapshot(t *testing.T, r *v1.Ready, wid string) *v1.WorkspaceSnapshot {
	t.Helper()
	for _, s := range r.GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			return s
		}
	}
	t.Fatalf("READY without workspace %s", wid)
	return nil
}

// assertGuestSees checks READY members / presences / voice states and GET …/members against want.
func assertGuestSees(t *testing.T, what string, snap *v1.WorkspaceSnapshot, guest *user, wid string, want map[string]bool) {
	t.Helper()
	got := map[string]bool{}
	for _, m := range snap.GetMembers() {
		got[m.GetUser().GetId()] = true
		if !want[m.GetUser().GetId()] {
			t.Fatalf("%s: READY lists %s (%s), want only %v", what, m.GetUser().GetDisplayName(), m.GetUser().GetId(), want)
		}
	}
	for id := range want {
		if !got[id] {
			t.Fatalf("%s: READY lacks %s", what, id)
		}
	}
	for _, p := range snap.GetPresences() {
		if !want[p.GetUserId()] {
			t.Fatalf("%s: READY presence of %s", what, p.GetUserId())
		}
	}
	for _, vs := range snap.GetVoiceStates() {
		if !want[vs.GetUserId()] {
			t.Fatalf("%s: READY voice state of %s", what, vs.GetUserId())
		}
	}
	var ms v1.ListMembersResponse
	guest.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &ms)
	if len(ms.GetMembers()) != len(want) {
		t.Fatalf("%s: GET members returns %d, want %d", what, len(ms.GetMembers()), len(want))
	}
	for _, m := range ms.GetMembers() {
		if !want[m.GetUser().GetId()] {
			t.Fatalf("%s: GET members lists %s", what, m.GetUser().GetId())
		}
	}
}

// waitMemberBefore reads until MEMBER_ADD of userID or the event other matches, and fails if
// other comes first: the guest must know a person before an event about them.
func waitMemberBefore(t *testing.T, g *gw, userID, what string, other func(*v1.DispatchEvent) bool) {
	t.Helper()
	e := g.wait("MEMBER_ADD before "+what, func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberAdd().GetMember().GetUser().GetId() == userID || other(e)
	})
	if e.GetWorkspaceMemberAdd() == nil {
		t.Fatalf("%s arrived before MEMBER_ADD of %s", what, userID)
	}
	g.wait(what, other)
}

func TestGuestTempRoomSeesOnlyRoomPeople(t *testing.T) {
	liveKitUp(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	bob, carol, dave := register(t, code), register(t, code), register(t, code)
	for _, u := range []*user{bob, carol, dave} { // online members: presence must not leak either
		dialGW(t).identify(u.token)
	}

	// A public temporary room (the default) of the owner: every member can view it.
	tr := tempRoom(t, o, wid, &v1.CreateTempRoomRequest{Name: "Встреча с клиентом", TtlSeconds: 3600})
	rid := tr.GetRoom().GetId()
	guest, _ := anonGuest(t, tr.GetInviteCode(), "Клиент")
	gg := dialGW(t)
	snap := guestSnapshot(t, gg.identify(guest.token), wid)
	assertGuestSees(t, "fresh guest", snap, guest, wid, map[string]bool{guest.id: true, o.id: true})
	for _, u := range []*user{bob, carol, dave} {
		guest.must(404, "GET", "/api/workspaces/"+wid+"/members/"+u.id, nil, nil)
	}
	guest.must(200, "GET", "/api/workspaces/"+wid+"/members/"+o.id, nil, nil)

	// Someone writes in the room: the guest learns them before the message.
	hello := send(t, carol, rid, "Добрый день", "")
	waitMemberBefore(t, gg, carol.id, "MESSAGE_CREATE", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetAuthorId() == carol.id
	})
	// Someone joins the call: the guest learns them before their voice state.
	joinVoice(t, dave, wid, rid)
	waitMemberBefore(t, gg, dave.id, "VOICE_STATE_UPDATE", func(e *v1.DispatchEvent) bool {
		return e.GetVoiceStateUpdate().GetState().GetUserId() == dave.id && e.GetVoiceStateUpdate().GetState().GetRoomId() == rid
	})
	// Bob never took part: still hidden, also from presence updates.
	dialGW(t).identify(bob.token)
	gg.quiet("anything about bob", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberAdd().GetMember().GetUser().GetId() == bob.id || e.GetPresenceUpdate().GetPresence().GetUserId() == bob.id
	})
	people := map[string]bool{guest.id: true, o.id: true, carol.id: true, dave.id: true}
	assertGuestSees(t, "reconnected guest", guestSnapshot(t, dialGW(t).identify(guest.token), wid), guest, wid, people)
	guest.must(404, "GET", "/api/workspaces/"+wid+"/members/"+bob.id, nil, nil)
	// Reactors: the guest's list leaves out people it does not see.
	thumbs := url.PathEscape("👍")
	bob.must(204, "PUT", "/api/messages/"+hello.GetId()+"/reactions/"+thumbs, nil, nil)
	o.must(204, "PUT", "/api/messages/"+hello.GetId()+"/reactions/"+thumbs, nil, nil)
	var rs v1.ListReactionUsersResponse
	guest.must(200, "GET", "/api/messages/"+hello.GetId()+"/reactions/"+thumbs, nil, &rs)
	if len(rs.GetUsers()) != 1 || rs.GetUsers()[0].GetId() != o.id {
		t.Fatalf("guest reactors: %v", rs.GetUsers())
	}

	// A guest admitted through the waiting room (ADR-0040) gets the same view.
	setGuestApproval(t, o, rid, true)
	knock, _ := anonGuest(t, tr.GetInviteCode(), "Второй клиент")
	kg := dialGW(t)
	kr := kg.identify(knock.token)
	assertGuestSees(t, "waiting guest", guestSnapshot(t, kr, wid), knock, wid, map[string]bool{knock.id: true})
	o.must(200, "POST", "/api/rooms/"+rid+"/admissions/"+knock.id,
		&v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_ADMITTED}, nil)
	kg.wait("ROOM_CREATE of the admitted room", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == rid })
	kg.wait("MEMBER_ADD of the author", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceMemberAdd().GetMember().GetUser().GetId() == carol.id
	})
	people[knock.id] = true
	assertGuestSees(t, "admitted guest", guestSnapshot(t, dialGW(t).identify(knock.token), wid), knock, wid, people)
}
