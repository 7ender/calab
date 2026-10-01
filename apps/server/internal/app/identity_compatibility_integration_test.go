//go:build integration

package app_test

import (
	"context"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
)

func compatibilityAuthority(t *testing.T, u *user, kind string, ws uuid.UUID, connection *uuid.UUID) *user {
	t.Helper()
	_, hash, err := auth.NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	params := sqlc.CreateScopedIdentitySessionParams{UserID: uuid.MustParse(u.id), RefreshTokenHash: hash, ExpiresAt: at.Add(10 * time.Minute), AuthorityKind: kind, AuthorityWorkspaceID: &ws, AuthorityConnectionID: connection}
	if kind == "recovery" {
		params.RecoveryAuthenticatedAt = &at
	}
	s, err := testDB.Q.CreateScopedIdentitySession(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	token, _, err := testApp.Auth.Tokens().Issue(s.UserID, s.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	return &user{client: &client{t: t, token: token, ip: "10.183.0.2"}, id: u.id, session: s.ID.String()}
}

func TestIdentityCompatibilityOwnAdmissionReceipt(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	setGuestApproval(t, o, room.Id, true)
	inv := roomLink(t, o, room.Id, &v1.CreateRoomInviteRequest{})
	guest, _ := anonGuest(t, inv.Code, "Receipt owner")
	g := dialGW(t)
	defer func() { _ = g.ws.CloseNow() }()
	if len(g.identify(guest.token).PendingAdmissions) != 1 {
		t.Fatal("pending own receipt missing")
	}
	o.must(200, "POST", "/api/rooms/"+room.Id+"/admissions/"+guest.id, &v1.DecideRoomAdmissionRequest{Status: v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED}, nil)
	declined := decided(g, room.Id, guest.id, v1.RoomAdmissionStatus_ROOM_ADMISSION_STATUS_DECLINED)
	if isMember(t, o, ws.Id, guest.id) != nil {
		t.Fatal("declined guest membership survived")
	}
	// Missing policy is the explicit migration off default. An optional row also
	// preserves the exact own guestView after membership has been removed.
	policy, err := testDB.Q.EnsureIdentityPolicy(context.Background(), uuid.MustParse(ws.Id))
	if err != nil {
		t.Fatal(err)
	}
	_, err = testDB.Q.SetIdentityPolicy(context.Background(), sqlc.SetIdentityPolicyParams{WorkspaceID: policy.WorkspaceID, ExpectedVersion: policy.Version, Mode: "optional", AssuranceMaxAgeSeconds: 3600})
	if err != nil {
		t.Fatal(err)
	}
	local := dialGW(t)
	defer func() { _ = local.ws.CloseNow() }()
	ready := local.identify(guest.token)
	if len(ready.PendingAdmissions) != 1 || len(ready.Workspaces) != 0 || ready.PendingAdmissions[0].User.DisplayName != "" || ready.PendingAdmissions[0].InviteCreatedBy != "" {
		t.Fatalf("receipt either missing or expanded authority: %v", ready)
	}
	for _, path := range []string{"/api/rooms/" + room.Id, "/api/rooms/" + room.Id + "/messages", "/api/rooms/" + room.Id + "/admissions"} {
		if st := guest.do("GET", path, nil, nil); st == 200 {
			t.Fatal("receipt opened protected resource", path)
		}
	}
	conn, err := testDB.Q.CreateIdentityConnection(context.Background(), sqlc.CreateIdentityConnectionParams{WorkspaceID: policy.WorkspaceID, Name: "Receipt fixture", Provider: "generic", Issuer: "https://receipt.identity.test", ClientID: "fixture", Status: "draft", Scopes: []string{"openid"}})
	if err != nil {
		t.Fatal(err)
	}
	scoped := compatibilityAuthority(t, guest, "workspace_sso", policy.WorkspaceID, &conn.ID)
	sg := dialGW(t)
	defer func() { _ = sg.ws.CloseNow() }()
	if len(sg.identify(scoped.token).PendingAdmissions) != 0 {
		t.Fatal("same user's scoped session received a local receipt")
	}
	og := dialGW(t)
	defer func() { _ = og.ws.CloseNow() }()
	og.identify(o.token)
	ev := &v1.DispatchEvent{Event: &v1.DispatchEvent_RoomAdmissionDecided{RoomAdmissionDecided: &v1.RoomAdmissionDecided{Admission: declined}}}
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(o.id), ev)
	og.quiet("other user's own receipt", 150*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetRoomAdmissionDecided() != nil })
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(guest.id), ev)
	sg.quiet("same user's scoped receipt", 150*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetRoomAdmissionDecided() != nil })
	policy, err = testDB.Q.GetIdentityPolicy(context.Background(), policy.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Q.SetIdentityPolicy(context.Background(), sqlc.SetIdentityPolicyParams{WorkspaceID: policy.WorkspaceID, ExpectedVersion: policy.Version, Mode: "enforced", AssuranceMaxAgeSeconds: 3600}); err != nil {
		t.Fatal(err)
	}
	eg := dialGW(t)
	defer func() { _ = eg.ws.CloseNow() }()
	if len(eg.identify(guest.token).PendingAdmissions) != 0 {
		t.Fatal("enforced workspace disclosed own receipt in READY")
	}
	(events.Redis{C: testRedis}).User(context.Background(), uuid.MustParse(guest.id), ev)
	eg.quiet("enforced own receipt event", 150*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetRoomAdmissionDecided() != nil })
}

func TestIdentityCompatibilityBotCardAndOperatorOffReauth(t *testing.T) {
	f := identitySetup(t, "optional")
	bot := createBot(t, owner(t), f.a.Id, "compat")
	f.local.must(200, "GET", "/api/bots/"+bot.id, nil, nil)
	f.scoped.must(403, "GET", "/api/bots/"+bot.id, nil, nil)
	bot.must(403, "GET", "/api/bots/"+bot.id, nil, nil)
	recovery := compatibilityAuthority(t, f.local, "recovery", uuid.MustParse(f.a.Id), nil)
	recovery.must(403, "GET", "/api/bots/"+bot.id, nil, nil)
	if settings, err := testCfg.IdentitySettings(); err != nil || settings != nil {
		t.Fatal("test must use the actual operator-off main App")
	}
	// A stale local proof can be renewed without provider/SSO operator keys.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE sessions SET local_authenticated_at = now() - interval '6 minutes' WHERE id=$1", f.local.session); err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"", "null", "https://evil.example", "https://app.example.com/path"} {
		status, _, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", f.local.token, origin, nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
		if status != 403 {
			t.Fatalf("untrusted origin %q: %d", origin, status)
		}
	}
	for _, token := range []string{f.scoped.token, recovery.token, bot.token} {
		status, _, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
		if status != 403 {
			t.Fatalf("wrong reauth authority: %d", status)
		}
	}
	status, _, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", f.local.token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "wrong-password"})
	if status != 401 {
		t.Fatalf("wrong password: %d", status)
	}
	status, data, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", f.local.token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
	var proof v1.LocalReauthResponse
	if status != 200 || protojson.Unmarshal(data, &proof) != nil || proof.AuthenticatedAt == nil {
		t.Fatalf("operator-off local reauth: %d %s", status, data)
	}
	row, err := testDB.Q.GetSession(context.Background(), uuid.MustParse(f.local.session))
	if err != nil || row.AuthorityKind != "local_account" || row.LocalAuthenticatedAt == nil || time.Since(*row.LocalAuthenticatedAt) > time.Minute {
		t.Fatalf("proof not renewed on same local session: %v %v", row, err)
	}
	for _, origin := range []string{"https://app.example.ru", "https://alias.example.org"} {
		status, _, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", f.local.token, origin, nil, &v1.LocalReauthRequest{CurrentPassword: "password123"})
		if status != 200 {
			t.Fatalf("trusted operator alias %q: %d", origin, status)
		}
	}
	limited := false
	for range 10 {
		status, _, _ := identityRequest(t, srv.URL, "POST", "/api/auth/local/reauth", f.local.token, "https://app.example.com", nil, &v1.LocalReauthRequest{CurrentPassword: "wrong-password"})
		if status == 429 {
			limited = true
			break
		}
		if status != 401 {
			t.Fatalf("reauth limiter attempt: %d", status)
		}
	}
	if !limited {
		t.Fatal("operator-off reauth bypassed existing limiter")
	}
	status, _, _ = identityRequest(t, srv.URL, "POST", "/api/auth/sso/workspaces/"+f.a.Id+"/begin", f.local.token, "https://app.example.com", nil, &v1.SSOBeginRequest{})
	if status != 503 {
		t.Fatalf("operator-off SSO should remain unavailable: %d", status)
	}
}

func TestIdentityCompatibilityReadyOver256Memberships(t *testing.T) {
	u := register(t, invite(t, owner(t), createWorkspace(t, owner(t), v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).Id))
	// SQL fixture avoids unrelated workspace creation quotas; the user remains a
	// member of the original invite workspace plus 257 supported owner memberships.
	prefix := uniq("compat")
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO workspaces (slug,name,owner_id) SELECT $1 || '-' || i, 'Lease fixture ' || i, $2 FROM generate_series(1,257) i`, prefix, u.id); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(context.Background(), `INSERT INTO workspace_members (workspace_id,user_id,role) SELECT id,$1,'owner' FROM workspaces WHERE owner_id=$1`, u.id); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = testDB.Pool.Exec(context.Background(), "DELETE FROM workspaces WHERE owner_id=$1", u.id)
	}()
	g := dialGW(t)
	defer func() { _ = g.ws.CloseNow() }()
	r := g.identify(u.token)
	if len(r.Workspaces) != 258 {
		t.Fatalf("READY silently lost supported memberships: %d", len(r.Workspaces))
	}
	// A workspace at the tail must continue receiving events, not just snapshots.
	last := r.Workspaces[len(r.Workspaces)-1].Workspace
	name := "After 256"
	u.must(200, "PATCH", "/api/workspaces/"+last.Id, &v1.UpdateWorkspaceRequest{Name: &name}, nil)
	g.wait("tail workspace event", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceUpdate().GetWorkspace().GetId() == last.Id && e.GetWorkspaceUpdate().GetWorkspace().GetName() == name
	})
}

func TestIdentityCompatibilityArchivedRoomParent(t *testing.T) {
	f := identitySetup(t, "enforced")
	f.prove(t, uuid.MustParse(f.local.session), time.Now())
	m := send(t, f.local, f.roomA, "Readable archived history", "")
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE rooms SET archived_at=now(), expires_at=now()-interval '1 minute' WHERE id=$1", f.roomA); err != nil {
		t.Fatal(err)
	}
	for _, u := range []*user{f.local, f.scoped} {
		u.must(200, "GET", "/api/rooms/"+f.roomA+"/messages", nil, nil)
		if code := errCode(t, u, "POST", "/api/rooms/"+f.roomA+"/messages"); code != v1.ErrorCode_ERROR_CODE_ROOM_ARCHIVED {
			t.Fatalf("archive write semantics changed: %v", code)
		}
		name := "Archive write"
		// The existing message handler hides failed room access as message 404.
		u.must(404, "PATCH", "/api/messages/"+m.Id, &v1.UpdateMessageRequest{Content: name}, nil)
	}
	// A resource parent lookup never substitutes for workspace authority.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE rooms SET archived_at=now(), expires_at=now()-interval '1 minute' WHERE id=$1", f.roomB); err != nil {
		t.Fatal(err)
	}
	f.scoped.must(403, "GET", "/api/rooms/"+f.roomB+"/messages", nil, nil)
	recovery := compatibilityAuthority(t, f.local, "recovery", uuid.MustParse(f.a.Id), nil)
	recovery.must(403, "GET", "/api/rooms/"+f.roomA+"/messages", nil, nil)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE rooms SET expires_at=NULL WHERE id=$1", f.roomA); err != nil {
		t.Fatal(err)
	}
	f.local.must(404, "GET", "/api/rooms/"+f.roomA+"/messages", nil, nil)
}

func TestIdentityCompatibilityPreviewChargedOnce(t *testing.T) {
	o, ws := wsOwner(t)
	code := invite(t, o, ws.Id)
	c := &client{t: t, ip: "10.184.0.1"}
	for range 30 {
		c.must(200, "GET", "/api/invites/"+code, nil, nil)
	}
	c.must(429, "GET", "/api/invites/"+code, nil, nil)
	if strings.Contains(string(c.lastBody), ws.Name) {
		t.Fatal("limited preview disclosed workspace metadata")
	}
}
