//go:build integration

package app_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Similar-address hint on sign-up (docs/09 #119): kv@gptunnel.ai while kv@gptunnel.ru exists.
func TestRegisterSimilarAccountHint(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	code := invite(t, o, ws.GetId())
	org := uniq("corp")
	local := uniq("kv")
	newClient := func() *client {
		seq++
		return &client{t: t, ip: fmt.Sprintf("10.7.%d.%d", seq/250, seq%250+1)}
	}
	req := func(email, code string, check bool) *v1.RegisterRequest {
		return &v1.RegisterRequest{Email: email, Password: "password123", DisplayName: "Kv", InviteCode: code, CheckSimilarAccount: check}
	}
	exists := func(email string) bool {
		var n int
		if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM users WHERE email = $1", email).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n > 0
	}
	existing := local + "@" + org + ".ru"
	newClient().must(201, "POST", "/api/auth/register", req(existing, code, false), nil)

	// Positive: same local part, same name, other TLD → only the hint, nothing created.
	sibling := local + "@" + org + ".ai"
	var hint v1.RegisterResponse
	newClient().must(200, "POST", "/api/auth/register", req(sibling, code, true), &hint)
	if !hint.GetSimilarAccount() || hint.GetTokens() != nil || hint.GetMe() != nil {
		t.Fatalf("hint response: %v", &hint)
	}
	if exists(sibling) {
		t.Fatal("the hint created an account")
	}
	// Case-insensitive on both parts.
	hint.Reset()
	newClient().must(200, "POST", "/api/auth/register", req(strings.ToUpper(local+"@"+org)+".AI", code, true), &hint)
	if !hint.GetSimilarAccount() {
		t.Fatal("no hint for an upper-case address")
	}
	// «Всё равно создать»: the same sign-up without the check goes through.
	var created v1.RegisterResponse
	newClient().must(201, "POST", "/api/auth/register", req(sibling, code, false), &created)
	if created.GetSimilarAccount() || created.GetTokens().GetAccessToken() == "" {
		t.Fatalf("plain sign-up: %v", &created)
	}

	// Negative: other local part; other organisation name; a longer name (sub.org.ai).
	for _, email := range []string{
		uniq("other") + "@" + org + ".ai",
		local + "@" + uniq("elsewhere") + ".ai",
		local + "@mail." + org + ".ai",
	} {
		var r v1.RegisterResponse
		newClient().must(201, "POST", "/api/auth/register", req(email, code, true), &r)
		if r.GetSimilarAccount() || r.GetTokens().GetAccessToken() == "" {
			t.Fatalf("%s: unexpected hint %v", email, &r)
		}
	}

	// The exact address stays a plain 409, never the hint.
	newClient().wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", "/api/auth/register", req(existing, code, true))

	// No oracle without a way in: invite-only registration without a (live) code refuses as
	// before, whatever the flag says.
	third := local + "@" + org + ".de"
	newClient().wantErr(403, v1.ErrorCode_ERROR_CODE_REGISTRATION_CLOSED, "POST", "/api/auth/register", req(third, "", true))
	newClient().wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "POST", "/api/auth/register", req(third, "no-such-code", true))

	// A domain of the workspace's email invitations counts as the same organisation.
	a, ws2 := wsOwner(t)
	lp := uniq("lp")
	orgA, orgB := uniq("alpha"), uniq("beta")
	newClient().must(201, "POST", "/api/auth/register", req(lp+"@"+orgA+".com", code, false), nil)
	a.must(201, "POST", "/api/workspaces/"+ws2.GetId()+"/invites/email", &v1.CreateEmailInviteRequest{Email: uniq("colleague") + "@" + orgA + ".com"}, nil)
	code2 := invite(t, a, ws2.GetId())
	hint.Reset()
	newClient().must(200, "POST", "/api/auth/register", req(lp+"@"+orgB+".org", code2, true), &hint)
	if !hint.GetSimilarAccount() {
		t.Fatal("no hint for a domain of the workspace's email invitations")
	}
	// No free oracle (security review): a sign-up that would fail anyway answers its usual
	// error, never the hint — here an emailed code of ws2 bound to another address.
	ecode := emailInviteCode(t, a, ws2.GetId(), uniq("bound")+"@"+orgB+".org")
	newClient().wantErr(403, v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH, "POST", "/api/auth/register", req(lp+"@"+orgB+".net", ecode, true))
	// …but only for that workspace's code.
	var r v1.RegisterResponse
	newClient().must(201, "POST", "/api/auth/register", req(lp+"@"+orgB+".org", code, true), &r)
	if r.GetSimilarAccount() {
		t.Fatal("hint through another workspace's invitations")
	}
}
