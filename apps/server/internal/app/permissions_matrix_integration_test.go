//go:build integration

package app_test

import (
	"fmt"
	"net/url"
	"slices"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// The permissions matrix (docs/16-permissions-matrix.md): action × who, for the owner, an admin,
// a member, a guest, custom roles with a single bit and room overrides for one user. ok = any
// 2xx; otherwise the exact status.

const ok = 0

func userOv(id string, allow, deny perm.Bits) *v1.RoomPermissionOverride {
	return &v1.RoomPermissionOverride{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER, TargetId: id, Allow: uint64(allow), Deny: uint64(deny)}
}

// sendRetry posts a message, waiting out the per-room message rate limit (5 per 5 s).
func sendRetry(t *testing.T, u *user, roomID, text string) *v1.Message {
	t.Helper()
	for range 20 {
		var r v1.CreateMessageResponse
		switch st := u.do("POST", "/api/rooms/"+roomID+"/messages", &v1.CreateMessageRequest{Content: text, Nonce: uniq("n")}, &r); st {
		case 201:
			return r.GetMessage()
		case 429:
			time.Sleep(500 * time.Millisecond)
		default:
			t.Fatalf("send as %s: %d", u.id, st)
		}
	}
	t.Fatal("send: still rate limited")
	return nil
}

func TestPermissionMatrixREST(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	var inv v1.CreateInviteResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 100}, &inv)
	code := inv.GetInvite().GetCode()
	adminRole, guestRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN, v1.WorkspaceRole_WORKSPACE_ROLE_GUEST

	admin, mem, guest, tgt := register(t, code), register(t, code), register(t, code), register(t, code)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+admin.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+guest.id, &v1.UpdateMemberRequest{Role: &guestRole}, nil)

	// Custom roles with a single bit. rolesMgr first: new roles go to the bottom, so it stays
	// the highest custom role (creating one needs a top role above position 2).
	single := map[string]perm.Bits{
		"rolesMgr": perm.ManageRoles, "wsMgr": perm.ManageWorkspace, "roomMgr": perm.ManageRoom,
		"msgMgr": perm.ManageMessages, "nick": perm.ManageNicknames,
		"invMem": perm.InviteMembers, "invGst": perm.InviteGuests,
	}
	actors := map[string]*user{"owner": o, "admin": admin, "member": mem, "guest": guest}
	for _, name := range []string{"rolesMgr", "wsMgr", "roomMgr", "msgMgr", "nick", "invMem", "invGst"} {
		u := register(t, code)
		r := newRole(t, o, wid, name, single[name])
		if st, _ := setMemberRoles(o, wid, u.id, r.GetId()); st != 200 {
			t.Fatalf("assign %s: %d", name, st)
		}
		actors[name] = u
	}
	junior := newRole(t, o, wid, "junior", 0) // at the bottom: below every other custom role

	// A text room: the guest sees it by a user override; "roomOv" manages this room only;
	// "noSend" may not write here; "roomInv" may invite guests (ADR-0043) to this room only.
	roomOv, noSend, roomInv := register(t, code), register(t, code), register(t, code)
	actors["roomOv"], actors["noSend"], actors["roomInv"] = roomOv, noSend, roomInv
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t"}, &cr)
	rid := cr.GetRoom().GetId()
	ovs := []*v1.RoomPermissionOverride{
		userOv(guest.id, perm.ViewRoom|perm.SendMessages, 0),
		userOv(roomOv.id, perm.ManageRoom|perm.ManageMessages, 0),
		userOv(noSend.id, 0, perm.SendMessages),
		userOv(roomInv.id, perm.InviteGuests, 0),
	}
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	var vr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "v"}, &vr)
	vid := vr.GetRoom().GetId()

	names := []string{"owner", "admin", "member", "guest", "rolesMgr", "wsMgr", "roomMgr", "msgMgr", "nick", "invMem", "invGst", "roomOv", "noSend", "roomInv"}
	// only lists who succeeds; everyone else gets `deny`.
	only := func(deny int, who ...string) map[string]int {
		out := map[string]int{}
		for _, n := range names {
			out[n] = deny
			if slices.Contains(who, n) {
				out[n] = ok
			}
		}
		return out
	}
	byTgt := sendRetry(t, tgt, rid, "pin me")
	thumbs := url.PathEscape("👍")
	cases := []struct {
		action string
		want   map[string]int
		call   func(u *user) int
	}{
		{"create room (MANAGE_ROOM, workspace)", only(403, "owner", "admin", "roomMgr"), func(u *user) int {
			return u.do("POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "x"}, nil)
		}},
		{"create category (MANAGE_ROOM, workspace)", only(403, "owner", "admin", "roomMgr"), func(u *user) int {
			return u.do("POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "c"}, nil)
		}},
		{"rename room (MANAGE_ROOM in the room)", only(403, "owner", "admin", "roomMgr", "roomOv"), func(u *user) int {
			n := "t"
			return u.do("PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Name: &n}, nil)
		}},
		{"room overrides, unchanged (MANAGE_ROOM in the room)", only(403, "owner", "admin", "roomMgr", "roomOv"), func(u *user) int {
			return u.do("PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
		}},
		{"room allow_recording (MANAGE_ROOM + MANAGE_RECORDINGS)", func() map[string]int {
			m := only(403, "owner", "admin")
			m["guest"] = 404 // the voice room is invisible to the guest
			return m
		}(), func(u *user) int {
			off := false
			return u.do("PATCH", "/api/rooms/"+vid, &v1.UpdateRoomRequest{AllowRecording: &off}, nil)
		}},
		// ADR-0043: MANAGE_ROOM / MANAGE_WORKSPACE no longer imply the invite bits.
		{"room guest link (INVITE_GUESTS in the room)", only(403, "owner", "admin", "invGst", "roomInv"), func(u *user) int {
			return u.do("POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, nil)
		}},
		{"room members-only link (INVITE_MEMBERS or INVITE_GUESTS in the room)", only(403, "owner", "admin", "invMem", "invGst", "roomInv"), func(u *user) int {
			return u.do("POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{MembersOnly: true}, nil)
		}},
		{"list room links (INVITE_GUESTS or INVITE_MEMBERS in the room)", only(403, "owner", "admin", "invMem", "invGst", "roomInv"), func(u *user) int {
			return u.do("GET", "/api/rooms/"+rid+"/invites", nil, nil)
		}},
		{"workspace invite (INVITE_MEMBERS)", only(403, "owner", "admin", "invMem"), func(u *user) int {
			return u.do("POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 1}, nil)
		}},
		{"list workspace invites (INVITE_MEMBERS)", only(403, "owner", "admin", "invMem"), func(u *user) int {
			return u.do("GET", "/api/workspaces/"+wid+"/invites", nil, nil)
		}},
		{"workspace settings (MANAGE_WORKSPACE)", only(403, "owner", "admin", "wsMgr"), func(u *user) int {
			n := "Team"
			return u.do("PATCH", "/api/workspaces/"+wid, &v1.UpdateWorkspaceRequest{Name: &n}, nil)
		}},
		// ADR-0048: members are MANAGE_MEMBERS now; MANAGE_WORKSPACE alone no longer reaches them.
		{"list bans (MANAGE_MEMBERS)", only(403, "owner", "admin"), func(u *user) int {
			return u.do("GET", "/api/workspaces/"+wid+"/bans", nil, nil)
		}},
		{"nickname of another member (MANAGE_NICKNAMES)", only(403, "owner", "admin", "nick"), func(u *user) int {
			n := "renamed"
			return u.do("PATCH", "/api/workspaces/"+wid+"/members/"+tgt.id, &v1.UpdateMemberRequest{Nickname: &n}, nil)
		}},
		{"create role (MANAGE_ROLES)", only(403, "owner", "admin", "rolesMgr"), func(u *user) int {
			return u.do("POST", "/api/workspaces/"+wid+"/roles", &v1.CreateRoleRequest{Name: uniq("r")}, nil)
		}},
		{"assign a role below mine (MANAGE_ROLES)", only(403, "owner", "admin", "rolesMgr"), func(u *user) int {
			st, _ := setMemberRoles(u, wid, tgt.id, junior.GetId())
			return st
		}},
		{"send a message (SEND_MESSAGES)", only(403, "owner", "admin", "member", "guest", "rolesMgr", "wsMgr", "roomMgr", "msgMgr", "nick", "invMem", "invGst", "roomOv", "roomInv"), func(u *user) int {
			for {
				if st := u.do("POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "hi", Nonce: uniq("n")}, nil); st != 429 {
					return st
				}
				time.Sleep(500 * time.Millisecond)
			}
		}},
		{"react (SEND_MESSAGES)", only(403, "owner", "admin", "member", "guest", "rolesMgr", "wsMgr", "roomMgr", "msgMgr", "nick", "invMem", "invGst", "roomOv", "roomInv"), func(u *user) int {
			return u.do("PUT", "/api/messages/"+byTgt.GetId()+"/reactions/"+thumbs, nil, nil)
		}},
		{"pin another's message (MANAGE_MESSAGES)", only(403, "owner", "admin", "msgMgr", "roomOv"), func(u *user) int {
			return u.do("PUT", "/api/messages/"+byTgt.GetId()+"/pin", nil, nil)
		}},
		{"delete another's message (MANAGE_MESSAGES)", only(403, "owner", "admin", "msgMgr", "roomOv"), func(u *user) int {
			return u.do("DELETE", "/api/messages/"+sendRetry(t, tgt, rid, "delete me").GetId(), nil, nil)
		}},
		{"kick a member (MANAGE_MEMBERS)", only(403, "owner", "admin"), func(u *user) int {
			return u.do("DELETE", "/api/workspaces/"+wid+"/members/"+register(t, code).id, nil, nil)
		}},
	}
	for _, c := range cases {
		for _, n := range names {
			want := c.want[n]
			got := c.call(actors[n])
			if (want == ok && (got < 200 || got > 299)) || (want != ok && got != want) {
				t.Errorf("%s as %s: status %d, want %s", c.action, n, got, map[bool]string{true: "2xx", false: fmt.Sprint(want)}[want == ok])
			}
		}
	}
}

// Hierarchy (ADR-0026, workspaces.outranks / rtc.outranks): MANAGE_MEMBERS on a custom role
// does not reach up; voice moderation stops at admins for everyone but the owner.
func TestPermissionMatrixHierarchy(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	admin, admin2 := register(t, code), register(t, code)
	for _, a := range []*user{admin, admin2} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	}
	mgr := newRole(t, o, wid, "mgr", perm.ManageMembers)
	senior := newRole(t, o, wid, "senior", 0)
	o.must(200, "PUT", "/api/workspaces/"+wid+"/roles/order", &v1.SetRoleOrderRequest{RoleIds: []string{senior.GetId(), mgr.GetId()}}, nil)
	m, top, plain := register(t, code), register(t, code), register(t, code)
	if st, _ := setMemberRoles(o, wid, m.id, mgr.GetId()); st != 200 {
		t.Fatal(st)
	}
	if st, _ := setMemberRoles(o, wid, top.id, senior.GetId()); st != 200 {
		t.Fatal(st)
	}
	kick := func(u *user, target string) int {
		return u.do("DELETE", "/api/workspaces/"+wid+"/members/"+target, nil, nil)
	}
	ban := func(u *user, target string) int {
		return u.do("POST", "/api/workspaces/"+wid+"/bans", &v1.CreateBanRequest{UserId: target}, nil)
	}
	for _, c := range []struct {
		what string
		got  int
		want int
	}{
		{"custom MANAGE_MEMBERS kicks a member with a higher custom role", kick(m, top.id), 403},
		{"custom MANAGE_MEMBERS bans a member with a higher custom role", ban(m, top.id), 403},
		{"custom MANAGE_MEMBERS kicks an admin", kick(m, admin.id), 403},
		{"admin kicks an admin", kick(admin, admin2.id), 403},
		{"admin bans the owner", ban(admin, o.id), 403},
		{"custom MANAGE_MEMBERS kicks a plain member", kick(m, plain.id), 204},
		{"admin kicks the senior member", kick(admin, top.id), 204},
	} {
		if c.got != c.want {
			t.Errorf("%s: %d, want %d", c.what, c.got, c.want)
		}
	}
}

// pastChecks maps a status that got past the permission checks to 0: a successful move
// needs a real LiveKit participant, which this matrix does not have.
func pastChecks(st int) int {
	if st == 403 {
		return st
	}
	return 0
}

func TestPermissionMatrixVoice(t *testing.T) {
	liveKitUp(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	adminRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	admin, admin2, mem, tm := register(t, code), register(t, code), register(t, code), register(t, code)
	for _, a := range []*user{admin, admin2} {
		o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+a.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	}
	mover, muter := register(t, code), register(t, code)
	for u, bits := range map[*user]perm.Bits{mover: perm.MoveMembers, muter: perm.MuteMembers} {
		if st, _ := setMemberRoles(o, wid, u.id, newRole(t, o, wid, uniq("r"), bits).GetId()); st != 200 {
			t.Fatal(st)
		}
	}
	a, b := voiceRoom(t, o, wid, "a", 0), voiceRoom(t, o, wid, "b", 0)
	locked := voiceRoom(t, o, wid, "locked", 0)
	o.must(200, "PUT", "/api/rooms/"+locked+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(tm.id, 0, perm.Connect)}}, nil)
	joinVoice(t, tm, wid, a)
	joinVoice(t, admin2, wid, a)
	joinVoice(t, o, wid, a)
	time.Sleep(50 * time.Millisecond)

	path := func(room, target, act string) string { return "/api/rooms/" + room + "/voice/" + target + "/" + act }
	move := func(u *user, target, to string) int {
		return u.do("POST", path(a, target, "move"), &v1.MoveMemberRequest{TargetRoomId: to}, nil)
	}
	for _, c := range []struct {
		what string
		got  int
		want int
	}{
		{"member moves a member", move(mem, tm.id, b), 403},
		{"MUTE_MEMBERS role moves a member", move(muter, tm.id, b), 403},
		{"MOVE_MEMBERS role moves an admin", move(mover, admin2.id, b), 403},
		{"MOVE_MEMBERS role moves the owner", move(mover, o.id, b), 403},
		{"member moves an admin", move(mem, admin2.id, b), 403},
		{"move into a room the member cannot connect to", move(admin, tm.id, locked), 403},
		{"member disconnects a member", mem.do("POST", path(a, tm.id, "disconnect"), nil, nil), 403},
		{"MOVE_MEMBERS role disconnects a member", mover.do("POST", path(a, tm.id, "disconnect"), nil, nil), 403},
		{"admin disconnects an admin", admin.do("POST", path(a, admin2.id, "disconnect"), nil, nil), 403},
		{"admin server-mutes an admin", admin.do("POST", path(a, admin2.id, "mute"), nil, nil), 403},
		{"MUTE_MEMBERS role server-mutes an admin", muter.do("POST", path(a, admin2.id, "mute"), nil, nil), 403},
		{"MUTE_MEMBERS role server-mutes a member", muter.do("POST", path(a, tm.id, "mute"), nil, nil), 204},
		{"MUTE_MEMBERS role lifts it", muter.do("POST", path(a, tm.id, "unmute"), nil, nil), 204},
		{"owner server-mutes an admin", o.do("POST", path(a, admin2.id, "mute"), nil, nil), 204},
		{"owner lifts it", o.do("POST", path(a, admin2.id, "unmute"), nil, nil), 204},
		// Past the checks: a MOVE_MEMBERS role reaches LiveKit (a successful move needs a real
		// participant — move_integration_test.go covers it with the lk CLI).
		{"MOVE_MEMBERS role moves a member", pastChecks(move(mover, tm.id, b)), 0},
		// An admin may move other admins and the owner (docs/09 п. 54); muting them stays
		// owner-only (rows above).
		{"admin moves an admin", pastChecks(move(admin, admin2.id, b)), 0},
		{"admin moves the owner", pastChecks(move(admin, o.id, b)), 0},
	} {
		if c.got != c.want {
			t.Errorf("%s: %d, want %d", c.what, c.got, c.want)
		}
	}
}

// A room that becomes visible with a role / override change arrives with its call: the
// participants' voice states follow the ROOM_CREATE (gateway dispatchGained).
func TestGainedRoomBringsItsCall(t *testing.T) {
	liveKitUp(t)
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	inside, byOverride, byRole := register(t, code), register(t, code), register(t, code)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "private", IsPrivate: true}, &cr)
	pid := cr.GetRoom().GetId()
	insiders := newRole(t, o, wid, "insiders", 0)
	base := append([]*v1.RoomPermissionOverride(nil), cr.GetRoom().GetPermissionOverrides()...)
	withInside := append(slices.Clone(base), userOv(inside.id, perm.ViewRoom, 0), roleOv(insiders.GetId(), perm.ViewRoom, 0))
	o.must(200, "PUT", "/api/rooms/"+pid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: withInside}, nil)
	joinVoice(t, inside, wid, pid)

	watch := func(u *user) *gw {
		g := dialGW(t)
		ready := g.identify(u.token)
		for _, s := range ready.GetWorkspaces() {
			if s.GetWorkspace().GetId() != wid {
				continue
			}
			for _, vs := range s.GetVoiceStates() {
				if vs.GetUserId() == inside.id && vs.GetRoomId() != "" {
					t.Fatalf("READY leaks the private room's voice state: %v", vs)
				}
			}
		}
		return g
	}
	expectCall := func(g *gw, how string) {
		t.Helper()
		g.wait(how+": ROOM_CREATE", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == pid })
		g.wait(how+": the participant's voice state", func(e *v1.DispatchEvent) bool {
			s := e.GetVoiceStateUpdate().GetState()
			return s.GetUserId() == inside.id && s.GetRoomId() == pid
		})
	}

	// A user override (ROOM_PERMISSIONS_UPDATE → roomChange).
	g1 := watch(byOverride)
	o.must(200, "PUT", "/api/rooms/"+pid+"/permissions", &v1.SetRoomPermissionsRequest{
		Overrides: append(slices.Clone(withInside), userOv(byOverride.id, perm.ViewRoom, 0)),
	}, nil)
	expectCall(g1, "override")

	// A role assignment (WORKSPACE_MEMBER_UPDATE → reviewRooms).
	g2 := watch(byRole)
	if st, _ := setMemberRoles(o, wid, byRole.id, insiders.GetId()); st != 200 {
		t.Fatalf("assign: %d", st)
	}
	expectCall(g2, "role")

	// Losing it: ROOM_DELETE (the client drops the room's voice states itself).
	if st, _ := setMemberRoles(o, wid, byRole.id); st != 200 {
		t.Fatalf("unassign: %d", st)
	}
	g2.wait("ROOM_DELETE", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == pid })
}
