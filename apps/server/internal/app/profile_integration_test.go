//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Member profile (docs/09 item 20): private notes, "member since", roles from the profile.

func TestUserNotes(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	alice := register(t, invite(t, o, ws.GetId()))
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	carol := register(t, invite(t, o, other.GetId())) // shares a workspace with o, not with bob
	note := func(u *user, subject string) *v1.UserNote {
		t.Helper()
		var r v1.UserNoteResponse
		u.must(200, "GET", "/api/users/"+subject+"/note", nil, &r)
		return r.GetNote()
	}
	put := func(u *user, subject, text string) *v1.UserNote {
		t.Helper()
		var r v1.UserNoteResponse
		u.must(200, "PUT", "/api/users/"+subject+"/note", &v1.PutUserNoteRequest{Text: text}, &r)
		return r.GetNote()
	}

	if n := note(bob, alice.id); n.GetText() != "" || n.GetUpdatedAt() != nil || n.GetSubjectId() != alice.id {
		t.Fatalf("no note yet: %v", n)
	}
	if n := put(bob, alice.id, "  знает Go  "); n.GetText() != "знает Go" || n.GetUpdatedAt() == nil {
		t.Fatalf("put: %v", n)
	}
	if n := note(bob, alice.id); n.GetText() != "знает Go" {
		t.Fatalf("get after put: %v", n)
	}
	put(bob, alice.id, "знает Go и SQL") // upsert
	if n := note(bob, alice.id); n.GetText() != "знает Go и SQL" {
		t.Fatalf("update: %v", n)
	}

	// Isolation: nobody else sees bob's note, not even its subject; each author has their own.
	if n := note(alice, alice.id); n.GetText() != "" {
		t.Fatal("subject sees the author's note")
	}
	if n := note(o, alice.id); n.GetText() != "" {
		t.Fatal("another author sees bob's note")
	}
	put(o, alice.id, "тимлид")
	if note(bob, alice.id).GetText() != "знает Go и SQL" || note(o, alice.id).GetText() != "тимлид" {
		t.Fatal("authors' notes are not separate")
	}
	put(bob, bob.id, "себе") // a note about oneself is allowed

	// No shared workspace (or DM), unknown or malformed ids: 404.
	bob.must(404, "GET", "/api/users/"+carol.id+"/note", nil, nil)
	bob.must(404, "PUT", "/api/users/"+carol.id+"/note", &v1.PutUserNoteRequest{Text: "x"}, nil)
	bob.must(404, "DELETE", "/api/users/"+carol.id+"/note", nil, nil)
	bob.must(404, "GET", "/api/users/"+uuid.NewString()+"/note", nil, nil)
	bob.must(404, "GET", "/api/users/nope/note", nil, nil)
	put(o, carol.id, "из другого пространства") // o shares the other workspace with carol

	// A DM is enough, even without a workspace in common any more.
	openDM(t, bob, alice.id, 201)
	alice.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/members/@me", nil, nil)
	if note(bob, alice.id).GetText() != "знает Go и SQL" {
		t.Fatal("DM partner's note lost")
	}

	// Limits; empty text and DELETE remove the note.
	bob.must(422, "PUT", "/api/users/"+alice.id+"/note", &v1.PutUserNoteRequest{Text: strings.Repeat("я", 1001)}, nil)
	put(bob, alice.id, strings.Repeat("я", 1000))
	if n := put(bob, alice.id, "   "); n.GetText() != "" || n.GetUpdatedAt() != nil {
		t.Fatalf("empty text must delete: %v", n)
	}
	put(bob, alice.id, "снова")
	bob.must(204, "DELETE", "/api/users/"+alice.id+"/note", nil, nil)
	bob.must(204, "DELETE", "/api/users/"+alice.id+"/note", nil, nil) // idempotent
	if note(bob, alice.id).GetText() != "" {
		t.Fatal("DELETE did not remove the note")
	}
	// o no longer shares anything with alice: 404, but o's note is kept.
	o.must(404, "GET", "/api/users/"+alice.id+"/note", nil, nil)
	if n, err := testDB.Q.GetUserNote(context.Background(), sqlc.GetUserNoteParams{
		AuthorID: uuid.MustParse(o.id), SubjectID: uuid.MustParse(alice.id),
	}); err != nil || n.Text != "тимлид" {
		t.Fatalf("DELETE touched another author's note: %v %v", n, err)
	}
}

func TestMemberSinceAndRolesFromProfile(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	alice := register(t, invite(t, o, ws.GetId()))
	base := "/api/workspaces/" + ws.GetId() + "/members/"

	// "Member since": registration (user.created_at) and joining this workspace (joined_at).
	var ml v1.ListMembersResponse
	alice.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/members", nil, &ml)
	found := false
	for _, m := range ml.GetMembers() {
		if m.GetUser().GetId() != bob.id {
			continue
		}
		found = true
		created, joined := m.GetUser().GetCreatedAt(), m.GetJoinedAt()
		if created == nil || joined == nil || joined.AsTime().Before(created.AsTime()) {
			t.Fatalf("member since: created %v joined %v", created, joined)
		}
	}
	if !found {
		t.Fatal("bob not listed")
	}

	// Roles from the profile go through PATCH …/members/{id} and reach everyone as
	// WORKSPACE_MEMBER_UPDATE.
	role := func(r v1.WorkspaceRole) *v1.UpdateMemberRequest { return &v1.UpdateMemberRequest{Role: &r} }
	g := dialGW(t)
	g.identify(alice.token)
	alice.must(403, "PATCH", base+bob.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN), nil) // MANAGE_WORKSPACE
	var upd v1.UpdateMemberResponse
	o.must(200, "PATCH", base+bob.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN), &upd)
	if upd.GetMember().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN || upd.GetMember().GetJoinedAt() == nil {
		t.Fatalf("grant admin: %v", upd.GetMember())
	}
	g.wait("WORKSPACE_MEMBER_UPDATE admin", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN
	})
	// An admin can manage members but only the owner grants or revokes admin; nobody changes
	// their own role or the owner's.
	bob.must(403, "PATCH", base+alice.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN), nil)
	bob.must(403, "PATCH", base+bob.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER), nil)
	bob.must(403, "PATCH", base+o.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER), nil)
	o.must(403, "PATCH", base+alice.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_OWNER), nil)
	o.must(200, "PATCH", base+bob.id, role(v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER), nil)
	g.wait("WORKSPACE_MEMBER_UPDATE member", func(e *v1.DispatchEvent) bool {
		m := e.GetWorkspaceMemberUpdate().GetMember()
		return m.GetUser().GetId() == bob.id && m.GetRole() == v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER
	})
}
