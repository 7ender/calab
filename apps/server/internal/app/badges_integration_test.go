//go:build integration

package app_test

import (
	"bytes"
	"crypto/rand"
	"image"
	"image/png"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// noisePNG is a w×h PNG that does not compress (random pixels): about 4·w·h bytes.
func noisePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	if _, err := rand.Read(img.Pix); err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func badgePicture(t *testing.T, u *user, wsID string, data []byte) string {
	t.Helper()
	st, f, _ := upload(t, u, "/api/workspaces/"+wsID+"/files", "badge.png", data)
	if st != 201 {
		t.Fatalf("upload: %d", st)
	}
	return f.GetId()
}

func newBadge(t *testing.T, u *user, wsID, name, fileID string) *v1.Badge {
	t.Helper()
	var r v1.CreateBadgeResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/badges", &v1.CreateBadgeRequest{Name: name, FileId: fileID}, &r)
	return r.GetBadge()
}

// TestBadgesLibrary (docs/09 #82): create / rename / re-picture / delete with MANAGE_WORKSPACE,
// the picture rules (image of this workspace, ≤ 128 KB, ≤ 256×256), at most 20 badges, the
// events and READY; the picture is readable by members only; bots and guests cannot manage.
func TestBadgesLibrary(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	base := "/api/workspaces/" + wid + "/badges"
	pic := badgePicture(t, o, wid, pngBytes(64, 64))

	// Picture rules.
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: "nope"}, nil)
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: badgePicture(t, o, wid, pngBytes(300, 64))}, nil)
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: badgePicture(t, o, wid, noisePNG(t, 200, 200))}, nil)
	st, txt, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "a.txt", []byte("hello"))
	if st != 201 {
		t.Fatalf("upload text: %d", st)
	}
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: txt.GetId()}, nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: badgePicture(t, o, other.GetId(), pngBytes(32, 32))}, nil)
	// Someone else's picture of this workspace is refused: a badge makes its file readable by
	// every member (e.g. an attachment of a restricted room must not leak that way).
	bobPic := badgePicture(t, bob, wid, pngBytes(32, 32))
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: bobPic}, nil)
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "   ", FileId: pic}, nil)
	o.must(422, "POST", base, &v1.CreateBadgeRequest{Name: "123456789012345678901234567890123", FileId: pic}, nil)

	// Rights: a member, a guest and a bot cannot manage; everyone may list.
	bob.must(403, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: pic}, nil)
	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	g.must(403, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: pic}, nil)
	b := createBot(t, o, wid, "Badger")
	manage := newRole(t, o, wid, "Managers", perm.ManageWorkspace)
	if st, _ := setMemberRoles(o, wid, b.id, manage.GetId()); st != 200 {
		t.Fatalf("bot role: %d", st)
	}
	b.must(403, "POST", base, &v1.CreateBadgeRequest{Name: "Acme", FileId: pic}, nil)

	// Before it is a badge, the unattached picture is the uploader's only.
	if st := fileStatus(t, bob, pic); st != 404 {
		t.Fatalf("unattached picture for a member: %d", st)
	}

	bg := dialGW(t)
	bg.identify(bob.token)
	acme := newBadge(t, o, wid, " Acme ", pic)
	if acme.GetName() != "Acme" || acme.GetFileId() != pic || acme.GetWorkspaceId() != wid {
		t.Fatalf("created: %v", acme)
	}
	bg.wait("BADGE_CREATE", func(e *v1.DispatchEvent) bool { return e.GetBadgeCreate().GetBadge().GetId() == acme.GetId() })

	// The picture: members (guests too) read it, outsiders do not.
	if st := fileStatus(t, bob, pic); st != 200 {
		t.Fatalf("badge picture for a member: %d", st)
	}
	if st := fileStatus(t, g, pic); st != 200 {
		t.Fatalf("badge picture for a guest: %d", st)
	}
	outsider := register(t, invite(t, o, other.GetId()))
	if st := fileStatus(t, outsider, pic); st != 404 {
		t.Fatalf("badge picture for an outsider: %d", st)
	}

	// Rename and a new picture.
	name := "Acme Corp"
	pic2 := badgePicture(t, o, wid, pngBytes(64, 64))
	var up v1.UpdateBadgeResponse
	o.must(200, "PATCH", base+"/"+acme.GetId(), &v1.UpdateBadgeRequest{Name: &name, FileId: &pic2}, &up)
	if up.GetBadge().GetName() != name || up.GetBadge().GetFileId() != pic2 {
		t.Fatalf("updated: %v", up.GetBadge())
	}
	bg.wait("BADGE_UPDATE", func(e *v1.DispatchEvent) bool { return e.GetBadgeUpdate().GetBadge().GetName() == name })
	bob.must(403, "PATCH", base+"/"+acme.GetId(), &v1.UpdateBadgeRequest{Name: &name}, nil)
	o.must(404, "PATCH", base+"/00000000-0000-0000-0000-000000000001", &v1.UpdateBadgeRequest{Name: &name}, nil)
	o.must(422, "PATCH", base+"/"+acme.GetId(), &v1.UpdateBadgeRequest{FileId: &bobPic}, nil)
	// A badge of another workspace is not reachable through this one.
	foreign := newBadge(t, o, other.GetId(), "Other", badgePicture(t, o, other.GetId(), pngBytes(16, 16)))
	o.must(404, "PATCH", base+"/"+foreign.GetId(), &v1.UpdateBadgeRequest{Name: &name}, nil)
	o.must(404, "DELETE", base+"/"+foreign.GetId(), nil, nil)

	// READY and the list carry the library.
	var list v1.ListBadgesResponse
	bob.must(200, "GET", base, nil, &list)
	if len(list.GetBadges()) != 1 || list.GetBadges()[0].GetName() != name {
		t.Fatalf("list: %v", list.GetBadges())
	}
	found := false
	for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
		if s.GetWorkspace().GetId() == wid {
			found = len(s.GetBadges()) == 1 && s.GetBadges()[0].GetId() == acme.GetId()
		}
	}
	if !found {
		t.Fatal("badge not in READY")
	}

	// At most 20.
	for i := 1; i < 20; i++ {
		newBadge(t, o, wid, "B", pic)
	}
	o.must(409, "POST", base, &v1.CreateBadgeRequest{Name: "21st", FileId: pic}, nil)

	// Delete.
	bob.must(403, "DELETE", base+"/"+acme.GetId(), nil, nil)
	o.must(204, "DELETE", base+"/"+acme.GetId(), nil, nil)
	o.must(404, "DELETE", base+"/"+acme.GetId(), nil, nil)
	o.must(201, "POST", base, &v1.CreateBadgeRequest{Name: "20th again", FileId: pic}, nil)
}

// TestBadgeAssign (docs/09 #82): PUT …/members/{id}/badge needs MANAGE_NICKNAMES and the
// hierarchy (not on a member at or above the caller); bots have none; "" clears; a badge of
// another workspace is refused; deleting a badge clears it from its members with
// WORKSPACE_MEMBER_UPDATE before BADGE_DELETE.
func TestBadgeAssign(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	wid := ws.GetId()
	alice := register(t, invite(t, o, wid))
	carol := register(t, invite(t, o, wid))
	dave := register(t, invite(t, o, wid))
	admin := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+carol.id, &v1.UpdateMemberRequest{Role: &admin}, nil)
	nicks := newRole(t, o, wid, "Nicks", perm.ManageNicknames)
	if st, _ := setMemberRoles(o, wid, dave.id, nicks.GetId()); st != 200 {
		t.Fatalf("give the role: %d", st)
	}
	acme := newBadge(t, o, wid, "Acme", badgePicture(t, o, wid, pngBytes(64, 64)))
	path := func(uid string) string { return "/api/workspaces/" + wid + "/members/" + uid + "/badge" }
	set := func(id string) *v1.SetMemberBadgeRequest { return &v1.SetMemberBadgeRequest{BadgeId: id} }

	bob.must(403, "PUT", path(alice.id), set(acme.GetId()), nil)  // no MANAGE_NICKNAMES
	dave.must(403, "PUT", path(carol.id), set(acme.GetId()), nil) // an admin is above the custom role
	carol.must(403, "PUT", path(o.id), set(acme.GetId()), nil)    // the owner is above an admin
	o.must(404, "PUT", path("00000000-0000-0000-0000-000000000001"), set(acme.GetId()), nil)
	o.must(422, "PUT", path(bob.id), set("00000000-0000-0000-0000-000000000001"), nil)
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	foreign := newBadge(t, o, other.GetId(), "Other", badgePicture(t, o, other.GetId(), pngBytes(16, 16)))
	o.must(422, "PUT", path(bob.id), set(foreign.GetId()), nil)
	b := createBot(t, o, wid, "Badgeless")
	o.must(403, "PUT", path(b.id), set(acme.GetId()), nil)
	g := register(t, invite(t, o, wid))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+g.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	g.must(403, "PUT", path(bob.id), set(acme.GetId()), nil)

	ag := dialGW(t)
	ag.identify(alice.token)
	var resp v1.SetMemberBadgeResponse
	dave.must(200, "PUT", path(bob.id), set(acme.GetId()), &resp)
	if resp.GetMember().GetBadgeId() != acme.GetId() || resp.GetMember().GetUser().GetId() != bob.id {
		t.Fatalf("response: %v", resp.GetMember())
	}
	ag.wait("WORKSPACE_MEMBER_UPDATE with the badge", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetBadgeId() == acme.GetId()
	})
	o.must(200, "PUT", path(alice.id), set(acme.GetId()), nil)
	o.must(200, "PUT", path(o.id), set(acme.GetId()), nil) // oneself
	var members v1.ListMembersResponse
	alice.must(200, "GET", "/api/workspaces/"+wid+"/members", nil, &members)
	n := 0
	for _, m := range members.GetMembers() {
		if m.GetBadgeId() == acme.GetId() {
			n++
		}
	}
	if n != 3 {
		t.Fatalf("members with the badge: %d", n)
	}

	// Clear.
	o.must(200, "PUT", path(alice.id), set(""), &resp)
	if resp.GetMember().GetBadgeId() != "" {
		t.Fatal("not cleared")
	}

	// Deleting the badge clears it: member updates, then BADGE_DELETE.
	ag = dialGW(t)
	ag.identify(alice.token)
	o.must(204, "DELETE", "/api/workspaces/"+wid+"/badges/"+acme.GetId(), nil, nil)
	ag.wait("WORKSPACE_MEMBER_UPDATE without the badge", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetBadgeId() == ""
	})
	ag.wait("BADGE_DELETE", func(e *v1.DispatchEvent) bool { return e.GetBadgeDelete().GetBadgeId() == acme.GetId() })
	for _, s := range dialGW(t).identify(alice.token).GetWorkspaces() {
		for _, m := range s.GetMembers() {
			if m.GetBadgeId() != "" && s.GetWorkspace().GetId() == wid {
				t.Fatalf("badge left on %s", m.GetUser().GetId())
			}
		}
	}
}
