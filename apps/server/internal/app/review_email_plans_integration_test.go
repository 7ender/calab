//go:build integration

package app_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

// Security review of ADR-0023 / ADR-0024.

// TestAdminGuardAndLimit: a SUPERADMIN_EMAILS address counts only once verified (every admin
// method is 404 before, like an unknown route; the env list matches case-insensitively), and
// a superadmin gets at most 60 admin requests per minute.
func TestAdminGuardAndLimit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	base := "/api/admin/workspaces/" + ws.GetId()
	routes := []struct{ method, path string }{
		{"GET", "/api/admin/workspaces?q=x"}, {"GET", base}, {"PUT", base + "/plan"}, {"GET", base + "/plan/log"},
	}

	// Registered with the listed address in other case, not verified yet.
	u, resp := registerRaw(t, strings.ToUpper(superadminEmail2[:1])+superadminEmail2[1:], invite(t, o, ws.GetId()), "")
	if resp.GetMe().GetIsSuperadmin() {
		t.Fatal("unverified address is superadmin")
	}
	for _, c := range routes {
		if st, e := u.apiErr(c.method, c.path); st != 404 || e.GetCode() != v1.ErrorCode_ERROR_CODE_NOT_FOUND {
			t.Errorf("%s %s unverified: %d %s", c.method, c.path, st, e.GetCode())
		}
	}
	code := nthMail(t, 1, mail.TemplateVerifyCode, superadminEmail2).Params["code"]
	var me v1.VerifyEmailResponse
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code}, &me)
	if !me.GetMe().GetIsSuperadmin() {
		t.Fatal("verified listed address is not superadmin")
	}

	// 60 per minute: the burst passes, then 429 with Retry-After.
	limited := false
	for i := range 70 {
		st := u.do("GET", base, nil, nil)
		if st == 429 {
			if i < 59 { // ≥ 60 requests pass (one more may refill meanwhile)
				t.Fatalf("429 after %d requests", i)
			}
			limited = true
			break
		}
		if st != 200 {
			t.Fatalf("request %d: %d", i, st)
		}
	}
	if !limited {
		t.Fatal("admin requests are not rate-limited")
	}
}

// TestPublicInvitePreview: GET /api/invites/{code} works without a token (the /join/<code>
// page of a signed-out visitor), shows only the public subset, the invited address of an
// email invitation, 404 for unknown / expired codes, and is limited to 30/min per IP.
func TestPublicInvitePreview(t *testing.T) {
	a, ws := wsOwner(t)
	code := invite(t, a, ws.GetId())
	anon := newClient(t)

	var p v1.GetInviteResponse
	anon.must(200, "GET", "/api/invites/"+code, nil, &p)
	w := p.GetWorkspace()
	if w.GetId() != ws.GetId() || w.GetName() != ws.GetName() || w.GetSlug() != ws.GetSlug() || p.GetMemberCount() != 1 || p.GetEmail() != "" {
		t.Fatalf("preview: %v", &p)
	}
	if w.GetOwnerId() != "" || w.GetStorageQuotaBytes() != 0 || w.GetMediaDefaults() != nil || w.GetPlan() != nil {
		t.Fatalf("preview leaks private workspace fields: %v", w)
	}

	anon.wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "GET", "/api/invites/NOSUCHCODE", nil)
	expired := invite(t, a, ws.GetId())
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspace_invites SET expires_at = now() - interval '1 minute' WHERE code = $1", expired); err != nil {
		t.Fatal(err)
	}
	anon.wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "GET", "/api/invites/"+expired, nil)

	// Email invitation: the invited address, for prefilling the sign-up form.
	addr := uniq("pub") + "@example.com"
	a.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/invites/email", &v1.CreateEmailInviteRequest{Email: addr}, nil)
	url := nthMail(t, 1, mail.TemplateWorkspaceInvite, addr).Params["url"]
	p.Reset()
	anon.must(200, "GET", "/api/invites/"+url[strings.LastIndex(url, "/")+1:], nil, &p)
	if p.GetEmail() != addr {
		t.Fatalf("email preview: %v", &p)
	}

	// 30 per minute per IP; another IP is not affected.
	flood := &client{t: t, ip: fmt.Sprintf("10.77.%d.1", seq%250)}
	limited := false
	for i := range 40 {
		st := flood.do("GET", "/api/invites/NOSUCHCODE", nil, nil)
		if st == 429 {
			if i < 29 {
				t.Fatalf("429 after %d requests", i)
			}
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("invite previews are not rate-limited")
	}
	newClient(t).must(200, "GET", "/api/invites/"+code, nil, nil)
}

// TestResetUnknownVsNoCode: an existing account without a reset code and an unknown address
// get the same answer from /password/reset.
func TestResetUnknownVsNoCode(t *testing.T) {
	u := register(t, invite(t, owner(t), createWorkspace(t, owner(t), v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	for _, email := range []string{u.email, uniq("nobody") + "@example.com"} {
		c := newClient(t)
		c.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_INVALID, "POST", "/api/auth/password/reset",
			&v1.ResetPasswordRequest{Email: email, Code: "123456", Password: "password12345"})
	}
}
