//go:build integration

package app_test

import (
	"slices"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// Second review of ADR-0026: hierarchy outside the roles API, no escalation of manager bits,
// concurrent reorders, role events only to members, voice removal on a lost CONNECT.

func TestRolesReviewHierarchy(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	code := invite(t, o, wid)
	bob, carol, dave, eve, frank := register(t, code), register(t, code), register(t, code), register(t, code), register(t, code)
	base := "/api/workspaces/" + wid

	// New roles go to the bottom: senior > mgr > rolesOnly > wsRole.
	senior := newRole(t, o, wid, "senior", 0)
	mgr := newRole(t, o, wid, "mgr", perm.ManageWorkspace|perm.ManageRoles)
	rolesOnly := newRole(t, o, wid, "roles", perm.ManageRoles|perm.MuteMembers)
	wsRole := newRole(t, o, wid, "ws", perm.ManageWorkspace)
	for u, id := range map[*user]string{bob: mgr.GetId(), carol: senior.GetId(), eve: rolesOnly.GetId()} {
		if st, _ := setMemberRoles(o, wid, u.id, id); st != 200 {
			t.Fatalf("assign: %d", st)
		}
	}

	// MANAGE_WORKSPACE on a custom role does not reach members above it.
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	bob.must(403, "PATCH", base+"/members/"+carol.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	bob.must(403, "DELETE", base+"/members/"+carol.id, nil, nil)
	bob.must(403, "POST", base+"/bans", &v1.CreateBanRequest{UserId: carol.id}, nil)
	bob.must(403, "DELETE", base+"/members/"+o.id, nil, nil)
	// ... but reaches those below (a plain member).
	bob.must(200, "PATCH", base+"/members/"+frank.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	bob.must(204, "DELETE", base+"/members/"+dave.id, nil, nil)
	// The owner / admins are unaffected.
	o.must(204, "DELETE", base+"/members/"+carol.id, nil, nil)

	// MANAGE_ROLES without MANAGE_WORKSPACE: no role carrying MANAGE_WORKSPACE, no manager
	// bits on a role, nothing at or above her own role.
	if st, _ := setMemberRoles(eve, wid, frank.id, wsRole.GetId()); st != 403 {
		t.Fatalf("eve assigns a MANAGE_WORKSPACE role: %d", st)
	}
	eve.must(403, "POST", base+"/roles", &v1.CreateRoleRequest{Name: "x", Permissions: uint64(perm.ManageWorkspace)}, nil)
	// Editing other bits of a lower role that has MANAGE_WORKSPACE is fine (Discord rule).
	withWS := uint64(perm.ManageWorkspace | perm.MuteMembers)
	eve.must(200, "PATCH", base+"/roles/"+wsRole.GetId(), &v1.UpdateRoleRequest{Permissions: &withWS}, nil)
	noWS := uint64(perm.MuteMembers)
	eve.must(403, "PATCH", base+"/roles/"+wsRole.GetId(), &v1.UpdateRoleRequest{Permissions: &noWS}, nil) // nor revoke it
	mute := uint64(perm.ManageRoles | perm.MuteMembers | perm.MoveMembers)
	eve.must(403, "PATCH", base+"/roles/"+rolesOnly.GetId(), &v1.UpdateRoleRequest{Permissions: &mute}, nil)
	if st, _ := setMemberRoles(eve, wid, eve.id); st != 403 {
		t.Fatalf("eve drops her own top role: %d", st)
	}
}

func TestRolesReviewConcurrentOrder(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	var ids []string
	for _, n := range []string{"a", "b", "c", "d"} {
		ids = append([]string{newRole(t, o, wid, n, 0).GetId()}, ids...) // highest first
	}
	orders := [][]string{
		{ids[3], ids[2], ids[1], ids[0]},
		{ids[1], ids[3], ids[0], ids[2]},
	}
	for range 5 {
		var wg sync.WaitGroup
		st := make([]int, len(orders))
		for i, ord := range orders {
			wg.Add(1)
			c := *o.client // own client per goroutine: do() records lastBody
			go func() {
				defer wg.Done()
				st[i] = c.do("PUT", "/api/workspaces/"+wid+"/roles/order", &v1.SetRoleOrderRequest{RoleIds: ord}, nil)
			}()
		}
		wg.Wait()
		if st[0] != 200 || st[1] != 200 {
			t.Fatalf("concurrent reorders: %v", st)
		}
		var got []string
		pos := map[int32]bool{}
		for _, r := range listRoles(t, o, wid) {
			if r.GetBuiltin() == v1.WorkspaceRole_WORKSPACE_ROLE_UNSPECIFIED {
				got = append(got, r.GetId())
				pos[r.GetPosition()] = true
			}
		}
		if !slices.Equal(got, orders[0]) && !slices.Equal(got, orders[1]) {
			t.Fatalf("order after concurrent reorders: %v", got)
		}
		for p := perm.PosCustom; p < perm.PosCustom+4; p++ {
			if !pos[p] {
				t.Fatalf("positions after concurrent reorders: %v", pos)
			}
		}
	}
}

func TestRolesReviewEventsAndVoice(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	wid, rid := ws.GetId(), room.GetId()
	// A member of another workspace only gets no ROLE_* of this one.
	stranger := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	sg := dialGW(t)
	sg.identify(stranger.token)
	bg := dialGW(t)
	bg.identify(bob.token)

	r := newRole(t, o, wid, "late", 0)
	bg.wait("ROLE_CREATE", func(e *v1.DispatchEvent) bool { return e.GetRoleCreate().GetRole().GetId() == r.GetId() })
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/roles/"+r.GetId(), nil, nil)
	bg.wait("ROLE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetRoleDelete().GetRoleId() == r.GetId() })
	sg.quiet("role event for a stranger", 300*time.Millisecond, func(e *v1.DispatchEvent) bool {
		return e.GetRoleCreate() != nil || e.GetRoleUpdate() != nil || e.GetRoleDelete() != nil
	})

	// Bob in voice; the member role loses CONNECT → he is removed from LiveKit.
	var j v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &j)
	webhook(t, whEvent("participant_joined", "ws_"+wid+"_room_"+rid, j.GetIdentity(), nil), "secret")
	bg.wait("bob in voice", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetRoomId() == rid })
	member := builtinRole(t, o, wid, v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER)
	noConnect := uint64(perm.RoleDefaults[perm.RoleMember] &^ perm.Connect)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &noConnect}, nil)
	deadline := time.Now().Add(5 * time.Second)
	for !lkRec.wasRemoved(j.GetIdentity()) {
		if time.Now().After(deadline) {
			t.Fatal("participant kept in LiveKit after the role lost CONNECT")
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Losing VIEW_ROOM through the role: the room disappears for bob.
	noView := uint64(perm.RoleDefaults[perm.RoleMember] &^ perm.ViewRoom)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &noView}, nil)
	bg.wait("ROOM_DELETE after VIEW_ROOM is gone", func(e *v1.DispatchEvent) bool { return e.GetRoomDelete().GetRoomId() == rid })
	full := uint64(perm.RoleDefaults[perm.RoleMember])
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/roles/"+member.GetId(), &v1.UpdateRoleRequest{Permissions: &full}, nil)
	bg.wait("ROOM_CREATE after VIEW_ROOM is back", func(e *v1.DispatchEvent) bool { return e.GetRoomCreate().GetRoom().GetId() == rid })
}
