//go:build integration

// docs/09 #36, ADR-0027: one invitation code for sign-up and joining — an emailed code and a
// link's code both work as the sign-up code of REGISTRATION_MODE=invite, in the preview and
// in POST /api/invites/{code}/join.
package app_test

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// emailInviteCode invites addr by email into ws and returns the code of the mailed link;
// the mail also shows the same code as text.
func emailInviteCode(t *testing.T, a *user, wsID, addr string) string {
	t.Helper()
	a.must(201, "POST", "/api/workspaces/"+wsID+"/invites/email", &v1.CreateEmailInviteRequest{Email: addr}, nil)
	m := nthMail(t, 1, mail.TemplateWorkspaceInvite, addr)
	url := m.Params["url"]
	code := url[strings.LastIndex(url, "/")+1:]
	if m.Params["code"] != code || !strings.Contains(m.Text, code+"\n") {
		t.Fatalf("invitation mail: code %q, params %v", code, m.Params)
	}
	return code
}

func verifyAddr(t *testing.T, u *user) *v1.VerifyEmailResponse {
	t.Helper()
	var vr v1.VerifyEmailResponse
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: nthMail(t, 1, mail.TemplateVerifyCode, u.email).Params["code"]}, &vr)
	return &vr
}

// Emailed code: sign-up (address from the invitation) → confirm → member; then reuse.
func TestInviteFlowEmailedCode(t *testing.T) {
	a, ws := wsOwner(t)
	path := "/api/workspaces/" + ws.GetId()
	addr := uniq("flow") + "@example.com"
	code := emailInviteCode(t, a, ws.GetId(), addr)

	anon := newClient(t)
	var p v1.GetInviteResponse
	anon.must(200, "GET", "/api/invites/"+code, nil, &p)
	if p.GetEmail() != addr || p.GetWorkspace().GetId() != ws.GetId() {
		t.Fatalf("preview: %v", &p)
	}
	anon.wantErr(403, v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("other") + "@example.com", Password: "password123", DisplayName: "O", InviteCode: code})

	// The invitation's address (any case) with its code passes the invite-only gate.
	u, resp := registerRaw(t, strings.ToUpper(addr[:1])+addr[1:], code, "")
	u.email = addr
	if resp.GetMe().GetEmailVerified() {
		t.Fatal("verified by the emailed code")
	}
	if st := u.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member before confirming: %d", st)
	}
	// Joining by the code before confirming: the address must be confirmed first.
	u.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/invites/"+code+"/join", nil)
	g := dialGW(t)
	g.identify(u.token)
	vr := verifyAddr(t, u)
	if ids := vr.GetJoinedWorkspaceIds(); len(ids) != 1 || ids[0] != ws.GetId() {
		t.Fatalf("joined: %v", ids)
	}
	g.wait("WORKSPACE_CREATE", func(e *v1.DispatchEvent) bool {
		return e.GetWorkspaceCreate().GetSnapshot().GetWorkspace().GetId() == ws.GetId()
	})
	u.must(200, "GET", path, nil, nil)

	// Reuse: the invitee may open the link again (preview + join answer with the membership).
	p.Reset()
	anon.must(200, "GET", "/api/invites/"+code, nil, &p)
	if p.GetEmail() != addr {
		t.Fatalf("preview after accepting: %v", &p)
	}
	var jr v1.JoinWorkspaceResponse
	u.must(200, "POST", "/api/invites/"+code+"/join", nil, &jr)
	if jr.GetWorkspace().GetId() != ws.GetId() || jr.GetMember().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER {
		t.Fatalf("join again: %v", &jr)
	}
	// Nobody else: another account gets the mismatch, a new sign-up the used-up code.
	o := owner(t)
	other := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	other.wantErr(403, v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH, "POST", "/api/invites/"+code+"/join", nil)
	anon.wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("late") + "@example.com", Password: "password123", DisplayName: "L", InviteCode: code})
	var dvr v1.VerifyEmailResponse // a second confirmation joins nothing new
	if st := u.do("POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: "000000"}, &dvr); st != 409 {
		t.Fatalf("verify again: %d", st)
	}
}

// An existing verified account invited by email joins through the dialog with the code.
func TestInviteFlowEmailedCodeSignedIn(t *testing.T) {
	a, ws := wsOwner(t)
	o := owner(t)
	u := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	code := emailInviteCode(t, a, ws.GetId(), u.email)
	var jr v1.JoinWorkspaceResponse
	u.must(200, "POST", "/api/invites/"+code+"/join", nil, &jr)
	if jr.GetWorkspace().GetId() != ws.GetId() || jr.GetMember().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER {
		t.Fatalf("join: %v", &jr)
	}
	u.must(200, "POST", "/api/invites/"+code+"/join", nil, nil) // idempotent
	var list v1.ListEmailInvitesResponse
	a.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/invites/email", nil, &list)
	if len(list.GetInvites()) != 0 {
		t.Fatalf("accepted invitation still pending: %v", &list)
	}
}

// A link's code: sign-up joins at once (before the address is confirmed); confirming joins
// nothing else; the same code in the join dialog answers with the membership.
func TestInviteFlowLinkCode(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	anon := newClient(t)
	anon.wantErr(403, v1.ErrorCode_ERROR_CODE_REGISTRATION_CLOSED, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("nocode") + "@example.com", Password: "password123", DisplayName: "N"})
	anon.wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: uniq("bad") + "@example.com", Password: "password123", DisplayName: "B", InviteCode: "NOSUCHCODE"})

	u, _ := registerRaw(t, uniq("link")+"@example.com", code, "")
	u.must(200, "GET", "/api/workspaces/"+ws.GetId(), nil, nil)
	if vr := verifyAddr(t, u); len(vr.GetJoinedWorkspaceIds()) != 0 || !vr.GetMe().GetEmailVerified() {
		t.Fatalf("verify: %v", vr)
	}
	var jr v1.JoinWorkspaceResponse
	u.must(200, "POST", "/api/invites/"+code+"/join", nil, &jr)
	if jr.GetWorkspace().GetId() != ws.GetId() {
		t.Fatalf("join again: %v", &jr)
	}
}

// A suspended workspace's emailed code no longer passes the invite-only gate (item 32): the
// sign-up is refused although the code joins only after the address is confirmed.
func TestInviteFlowEmailedCodeSuspended(t *testing.T) {
	a, ws := wsOwner(t)
	addr := uniq("susp") + "@example.com"
	code := emailInviteCode(t, a, ws.GetId(), addr)
	suspend(t, ws.GetId(), true, "review")
	newClient(t).wantErr(403, v1.ErrorCode_ERROR_CODE_WORKSPACE_SUSPENDED, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: addr, Password: "password123", DisplayName: "S", InviteCode: code})
	suspend(t, ws.GetId(), false, "")
	u, resp := registerRaw(t, addr, code, "")
	if resp.GetMe().GetEmailVerified() {
		t.Fatal("verified by the emailed code")
	}
	if ids := verifyAddr(t, u).GetJoinedWorkspaceIds(); len(ids) != 1 || ids[0] != ws.GetId() {
		t.Fatalf("joined: %v", ids)
	}
}
