//go:build integration

package app_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Joining through a room link with an account adds a global-account membership in the link's
// workspace: like /api/invites/{code}/join it needs local-account authority. A workspace_sso
// session of A or a recovery session must not join a room of another workspace.
func TestIdentityRoomInviteJoinNeedsLocalAuthority(t *testing.T) {
	f := identitySetup(t, "optional")
	ctx := context.Background()
	o := owner(t)
	c := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	var room v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+c.Id+"/rooms", &v1.CreateRoomRequest{Name: "Foreign voice", Type: v1.RoomType_ROOM_TYPE_VOICE}, &room)
	link := roomLink(t, o, room.Room.Id, &v1.CreateRoomInviteRequest{})
	uid, wsA, wsC := uuid.MustParse(f.local.id), uuid.MustParse(f.a.Id), uuid.MustParse(c.Id)
	members := func() int {
		var n int
		if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", wsC, uid).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	at := time.Now()
	_, hash, _ := auth.NewRefreshSecret()
	session, err := testDB.Q.CreateScopedIdentitySession(ctx, sqlc.CreateScopedIdentitySessionParams{UserID: uid, RefreshTokenHash: hash, ExpiresAt: at.Add(10 * time.Minute), AuthorityKind: "recovery", AuthorityWorkspaceID: &wsA, RecoveryAuthenticatedAt: &at})
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := testApp.Auth.Tokens().Issue(session.UserID, session.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	recovery := &user{client: &client{t: t, token: token}, id: f.local.id}

	for name, u := range map[string]*user{"workspace_sso(A)": f.scoped, "recovery(A)": recovery} {
		if st := u.do("POST", "/api/room-invites/"+link.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, nil); st != 403 {
			t.Fatalf("%s joined another workspace's room: %d %s", name, st, u.lastBody)
		}
		if members() != 0 {
			t.Fatalf("%s created a membership", name)
		}
	}
	// The independent local session still can.
	f.local.must(200, "POST", "/api/room-invites/"+link.GetCode()+"/join", &v1.JoinRoomInviteRequest{}, nil)
	if members() != 1 {
		t.Fatal("local join did not add the membership")
	}
}

// In an enforced workspace a room link still works for a member whose local session holds a
// current SSO assurance for it; a password-only session, scoped sessions (workspace_sso,
// recovery: never a global-membership authority, whatever their workspace) and an
// account-less join are refused.
func TestIdentityRoomInviteEnforcedNeedsAssurance(t *testing.T) {
	f := identitySetup(t, "optional")
	ctx := context.Background()
	o := owner(t)
	var room v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+f.a.Id+"/rooms", &v1.CreateRoomRequest{Name: "Enforced private", Type: v1.RoomType_ROOM_TYPE_TEXT, IsPrivate: true}, &room)
	link := roomLink(t, o, room.Room.Id, &v1.CreateRoomInviteRequest{AllowGuests: func() *bool { b := true; return &b }()})
	ws, uid := uuid.MustParse(f.a.Id), uuid.MustParse(f.local.id)
	policy, err := testDB.Q.GetIdentityPolicy(ctx, ws)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = testDB.Q.SetIdentityPolicy(ctx, sqlc.SetIdentityPolicyParams{WorkspaceID: ws, Mode: "enforced", AssuranceMaxAgeSeconds: 3600, ExpectedVersion: policy.Version}); err != nil {
		t.Fatal(err)
	}
	overrides := func() int {
		var n int
		if err := testDB.Pool.QueryRow(ctx, "SELECT count(*) FROM room_permissions WHERE room_id=$1 AND target_type='user' AND target_id=$2", uuid.MustParse(room.Room.Id), f.local.id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	join := "/api/room-invites/" + link.GetCode() + "/join"

	// Scoped sessions: workspace_sso of B (not A's authority) and recovery of A.
	at := time.Now()
	issue := func(p sqlc.CreateScopedIdentitySessionParams) *user {
		t.Helper()
		_, hash, _ := auth.NewRefreshSecret()
		p.UserID, p.RefreshTokenHash, p.ExpiresAt = uid, hash, at.Add(10*time.Minute)
		s, err := testDB.Q.CreateScopedIdentitySession(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		token, _, err := testApp.Auth.Tokens().Issue(s.UserID, s.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		return &user{client: &client{t: t, token: token}, id: f.local.id}
	}
	recovery := issue(sqlc.CreateScopedIdentitySessionParams{AuthorityKind: "recovery", AuthorityWorkspaceID: &ws, RecoveryAuthenticatedAt: &at})
	anon := &client{t: t, ip: "10.77.9.1"}
	for name, st := range map[string]int{
		"password-only local": f.local.do("POST", join, &v1.JoinRoomInviteRequest{}, nil),
		"workspace_sso(A)":    f.scoped.do("POST", join, &v1.JoinRoomInviteRequest{}, nil),
		"recovery(A)":         recovery.do("POST", join, &v1.JoinRoomInviteRequest{}, nil),
		"account-less":        anon.do("POST", join, &v1.JoinRoomInviteRequest{Nickname: "Guest"}, nil),
	} {
		if st != 403 {
			t.Fatalf("%s joined an enforced room link: %d", name, st)
		}
	}
	if overrides() != 0 {
		t.Fatal("refused join granted access")
	}
	// With a current SSO assurance on the local session the member joins.
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	f.local.must(200, "POST", join, &v1.JoinRoomInviteRequest{}, nil)
	if overrides() != 1 {
		t.Fatal("assured member got no access through the link")
	}
}
