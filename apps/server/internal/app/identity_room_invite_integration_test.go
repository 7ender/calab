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
