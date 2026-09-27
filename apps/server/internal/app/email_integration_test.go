//go:build integration

// ADR-0023: email verification, password reset, invitations by email, mail outbox.
package app_test

import (
	"context"
	"errors"
	"fmt"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

const mailWait = 10 * time.Second

// apiErr performs a request and returns the status and the ApiError body.
func (c *client) apiErrBody(method, path string, in proto.Message) (int, *v1.ApiError) {
	c.t.Helper()
	st := c.do(method, path, in, nil)
	var e v1.ApiError
	_ = protojson.Unmarshal(c.lastBody, &e)
	return st, &e
}

func (c *client) wantErr(status int, code v1.ErrorCode, method, path string, in proto.Message) {
	c.t.Helper()
	st, e := c.apiErrBody(method, path, in)
	if st != status || e.GetCode() != code {
		c.t.Fatalf("%s %s: %d %s, want %d %s", method, path, st, e.GetCode(), status, code)
	}
}

// nthMail waits for the n-th mail of template tmpl to addr.
func nthMail(t *testing.T, n int, tmpl mail.Template, addr string) mail.Message {
	t.Helper()
	m, ok := testMail.WaitN(mailWait, n, func(m mail.Message) bool {
		return m.Template == tmpl && strings.EqualFold(m.To, addr)
	})
	if !ok {
		t.Fatalf("no mail #%d %s to %s", n, tmpl, addr)
	}
	return m
}

// newClient is a client with its own rate-limit bucket.
func newClient(t *testing.T) *client {
	seq++
	return &client{t: t, ip: fmt.Sprintf("10.9.%d.%d", seq/250, seq%250+1)}
}

// registerRaw registers without the test helper's automatic verification.
func registerRaw(t *testing.T, email, invite, lang string) (*user, *v1.RegisterResponse) {
	t.Helper()
	c := newClient(t)
	c.lang = lang
	var resp v1.RegisterResponse
	c.must(201, "POST", "/api/auth/register", &v1.RegisterRequest{
		Email: email, Password: "password123", DisplayName: "Mailer", InviteCode: invite, DeviceName: "test",
	}, &resp)
	c.token = resp.GetTokens().GetAccessToken()
	return &user{client: c, id: resp.GetMe().GetUser().GetId(), refresh: resp.GetTokens().GetRefreshToken(),
		session: resp.GetTokens().GetSessionId(), email: email}, &resp
}

func TestEmailVerification(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	email := uniq("verify") + "@example.com"
	u, resp := registerRaw(t, email, invite(t, o, ws.GetId()), "ru-RU,ru;q=0.9")
	if resp.GetMe().GetEmailVerified() || resp.GetMe().GetLocale() != "ru" {
		t.Fatalf("new account: %v", resp.GetMe())
	}
	// Registration mails a code, in the account's language.
	m := nthMail(t, 1, mail.TemplateVerifyCode, email)
	code := m.Params["code"]
	if len(code) != 6 || !strings.HasPrefix(m.Subject, "Код подтверждения") {
		t.Fatalf("code mail: %q %q", code, m.Subject)
	}

	// Unverified: reading works, creating workspaces / invites / DMs does not.
	u.must(200, "GET", "/api/workspaces", nil, nil)
	u.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/workspaces",
		&v1.CreateWorkspaceRequest{Slug: uniq("ws-"), Name: "X"})
	u.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/dms", &v1.CreateDmRequest{UserId: o.id})

	// A second code only after 60 s.
	u.wantErr(429, v1.ErrorCode_ERROR_CODE_RATE_LIMITED, "POST", "/api/auth/verify/send", nil)
	u.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: "12"})
	wrong := "000000"
	if code == wrong {
		wrong = "111111"
	}
	u.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_INVALID, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: wrong})

	// Signing in while unverified mails a fresh code (the previous one is older than 60 s).
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE email_codes SET created_at = now() - interval '2 minutes' WHERE user_id = $1", u.id); err != nil {
		t.Fatal(err)
	}
	var login v1.LoginResponse
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &login)
	if login.GetMe().GetEmailVerified() {
		t.Fatal("login: verified")
	}
	code = nthMail(t, 2, mail.TemplateVerifyCode, email).Params["code"]

	var me v1.VerifyEmailResponse
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code[:3] + " " + code[3:]}, &me)
	if !me.GetMe().GetEmailVerified() {
		t.Fatal("not verified after the code")
	}
	var got v1.GetMeResponse
	u.must(200, "GET", "/api/me", nil, &got)
	if !got.GetMe().GetEmailVerified() {
		t.Fatal("GET /api/me: not verified")
	}
	u.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", "/api/auth/verify/send", nil)
	u.must(201, "POST", "/api/workspaces", &v1.CreateWorkspaceRequest{Slug: uniq("ws-"), Name: "Mine"}, nil)
	u.must(201, "POST", "/api/dms", &v1.CreateDmRequest{UserId: o.id}, nil)
}

func TestEmailCodeAttempts(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	email := uniq("attempts") + "@example.com"
	u, _ := registerRaw(t, email, invite(t, o, ws.GetId()), "")
	code := nthMail(t, 1, mail.TemplateVerifyCode, email).Params["code"]
	wrong := "999999"
	if code == wrong {
		wrong = "999998"
	}
	for i := 1; i <= 5; i++ {
		want := v1.ErrorCode_ERROR_CODE_CODE_INVALID
		if i == 5 {
			want = v1.ErrorCode_ERROR_CODE_CODE_EXPIRED // the fifth wrong attempt uses the code up
		}
		u.wantErr(422, want, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: wrong})
	}
	// Even the right code does not work any more.
	u.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_EXPIRED, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code})
	// A new code (after the 60 s resend pause) works.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE email_codes SET created_at = now() - interval '2 minutes' WHERE user_id = $1", u.id); err != nil {
		t.Fatal(err)
	}
	u.must(204, "POST", "/api/auth/verify/send", nil, nil)
	code2 := nthMail(t, 2, mail.TemplateVerifyCode, email).Params["code"]
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code2}, nil)
	// The stored code is a hash, never the digits.
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM email_codes WHERE code_hash NOT LIKE '$argon2id$%'").Scan(&n); err != nil || n != 0 {
		t.Fatalf("codes not hashed: %d %v", n, err)
	}
}

func TestPasswordReset(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	// A second session of the same account.
	var second v1.LoginResponse
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: u.email, Password: "password123"}, &second)

	anon := newClient(t)
	anon.must(204, "POST", "/api/auth/password/forgot", &v1.ForgotPasswordRequest{Email: "nobody-" + uniq("x") + "@example.com"}, nil)
	anon.must(204, "POST", "/api/auth/password/forgot", &v1.ForgotPasswordRequest{Email: strings.ToUpper(u.email[:1]) + u.email[1:]}, nil)
	code := nthMail(t, 1, mail.TemplatePasswordReset, u.email).Params["code"]

	wrong := "123123"
	if code == wrong {
		wrong = "321321"
	}
	anon.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_INVALID, "POST", "/api/auth/password/reset",
		&v1.ResetPasswordRequest{Email: u.email, Code: wrong, Password: "new-password-1"})
	anon.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_INVALID, "POST", "/api/auth/password/reset",
		&v1.ResetPasswordRequest{Email: "nobody@example.com", Code: code, Password: "new-password-1"})
	anon.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "POST", "/api/auth/password/reset",
		&v1.ResetPasswordRequest{Email: u.email, Code: code, Password: "short"})
	anon.must(204, "POST", "/api/auth/password/reset", &v1.ResetPasswordRequest{Email: u.email, Code: code, Password: "new-password-1"}, nil)

	// Every session is revoked: access tokens and refresh tokens.
	if st := u.do("GET", "/api/me", nil, nil); st != 401 {
		t.Fatalf("old access token after reset: %d", st)
	}
	second2 := &client{t: t, token: second.GetTokens().GetAccessToken()}
	if st := second2.do("GET", "/api/me", nil, nil); st != 401 {
		t.Fatalf("other session after reset: %d", st)
	}
	if st := anon.do("POST", "/api/auth/refresh", &v1.RefreshRequest{RefreshToken: u.refresh}, nil); st != 401 {
		t.Fatalf("refresh after reset: %d", st)
	}
	// The code is single-use; the new password works, the old one does not.
	anon.wantErr(422, v1.ErrorCode_ERROR_CODE_CODE_INVALID, "POST", "/api/auth/password/reset",
		&v1.ResetPasswordRequest{Email: u.email, Code: code, Password: "new-password-2"})
	if st := newClient(t).do("POST", "/api/auth/login", &v1.LoginRequest{Email: u.email, Password: "password123"}, nil); st != 401 {
		t.Fatalf("old password: %d", st)
	}
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: u.email, Password: "new-password-1"}, nil)
}

func TestChangeEmailWithCode(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	newEmail := uniq("changed") + "@example.com"
	var resp v1.UpdateMeResponse
	u.must(200, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: newEmail, CurrentPassword: "password123"}, &resp)
	if resp.GetMe().GetEmail() != u.email || resp.GetMe().GetPendingEmail() != newEmail || !resp.GetMe().GetEmailVerified() {
		t.Fatalf("pending change: %v", resp.GetMe())
	}
	code := nthMail(t, 1, mail.TemplateVerifyCode, newEmail).Params["code"]
	var vresp v1.VerifyEmailResponse
	u.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code}, &vresp)
	if vresp.GetMe().GetEmail() != newEmail || vresp.GetMe().GetPendingEmail() != "" || !vresp.GetMe().GetEmailVerified() {
		t.Fatalf("after confirming: %v", vresp.GetMe())
	}
	newClient(t).must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: newEmail, Password: "password123"}, nil)
}

// wsOwner returns a fresh verified user owning a fresh workspace (own rate-limit buckets).
func wsOwner(t *testing.T) (*user, *v1.Workspace) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	u := register(t, invite(t, o, ws.GetId()))
	return u, createWorkspace(t, u, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
}

func TestInviteLookupAndAddMember(t *testing.T) {
	a, ws := wsOwner(t)
	member := register(t, invite(t, a, ws.GetId())) // plain member: no invite right
	o := owner(t)
	outsider := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	target := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	path := "/api/workspaces/" + ws.GetId()

	member.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: target.email})
	outsider.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: target.email})

	var lr v1.InviteLookupResponse
	a.must(200, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: strings.ToUpper(target.email)}, &lr)
	if lr.GetUser().GetId() != target.id || lr.GetMember() {
		t.Fatalf("lookup: %v", &lr)
	}
	lr.Reset()
	a.must(200, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: member.email}, &lr)
	if lr.GetUser().GetId() != member.id || !lr.GetMember() {
		t.Fatalf("lookup of a member: %v", &lr)
	}
	lr.Reset()
	a.must(200, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: "nobody-" + uniq("x") + "@example.com"}, &lr)
	if lr.GetUser() != nil {
		t.Fatal("unknown address found")
	}
	// Unverified accounts are not found (and cannot be added).
	unverified, _ := registerRaw(t, uniq("unv")+"@example.com", invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()), "")
	lr.Reset()
	a.must(200, "POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: unverified.email}, &lr)
	if lr.GetUser() != nil {
		t.Fatal("unverified account found")
	}
	a.wantErr(404, v1.ErrorCode_ERROR_CODE_NOT_FOUND, "POST", path+"/members", &v1.AddMemberRequest{UserId: unverified.id})
	member.wantErr(403, v1.ErrorCode_ERROR_CODE_FORBIDDEN, "POST", path+"/members", &v1.AddMemberRequest{UserId: target.id})

	var added v1.AddMemberResponse
	a.must(201, "POST", path+"/members", &v1.AddMemberRequest{UserId: target.id}, &added)
	if added.GetMember().GetUser().GetId() != target.id || added.GetMember().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER {
		t.Fatalf("added: %v", &added)
	}
	target.must(200, "GET", path, nil, nil) // now a member
	a.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", path+"/members", &v1.AddMemberRequest{UserId: target.id})
	if m := nthMail(t, 1, mail.TemplateWorkspaceAdded, target.email); m.Params["workspace"] != ws.GetName() {
		t.Fatalf("added mail: %v", m.Params)
	}

	// 20 lookups per minute per user.
	limited := false
	for range 25 {
		if st := a.do("POST", path+"/invites/lookup", &v1.InviteLookupRequest{Email: "x@example.com"}, nil); st == 429 {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("lookup is not rate-limited")
	}
}

func TestEmailInviteAutoJoin(t *testing.T) {
	a, ws := wsOwner(t)
	path := "/api/workspaces/" + ws.GetId()

	// (1) Invited address registers through the link: joins at once, verified by the link.
	first := uniq("inv1") + "@example.com"
	var created v1.CreateEmailInviteResponse
	a.must(201, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: first}, &created)
	if created.GetInvite().GetEmail() != first || created.GetInvite().GetRole() != v1.WorkspaceRole_WORKSPACE_ROLE_MEMBER {
		t.Fatalf("invite: %v", &created)
	}
	a.wantErr(429, v1.ErrorCode_ERROR_CODE_RATE_LIMITED, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: first})
	a.wantErr(422, v1.ErrorCode_ERROR_CODE_VALIDATION, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{
		Email: uniq("adm") + "@example.com", Role: v1.WorkspaceRole_WORKSPACE_ROLE_OWNER.Enum()})
	m := nthMail(t, 1, mail.TemplateWorkspaceInvite, first)
	url := m.Params["url"]
	code := url[strings.LastIndex(url, "/")+1:]
	if !strings.HasPrefix(url, testCfg.PublicAppURL+"/join/") || len(code) != 10 {
		t.Fatalf("link %q", url)
	}
	var list v1.ListEmailInvitesResponse
	a.must(200, "GET", path+"/invites/email", nil, &list)
	if len(list.GetInvites()) != 1 || list.GetInvites()[0].GetEmail() != first {
		t.Fatalf("list: %v", &list)
	}
	var links v1.ListInvitesResponse
	a.must(200, "GET", path+"/invites", nil, &links)
	for _, l := range links.GetInvites() {
		if l.GetCode() == code {
			t.Fatal("email invitation listed among links")
		}
	}
	var preview v1.GetInviteResponse
	a.must(200, "GET", "/api/invites/"+code, nil, &preview)
	if preview.GetEmail() != first {
		t.Fatalf("preview email %q", preview.GetEmail())
	}
	// Bound to the address: another email cannot use the code.
	c := newClient(t)
	if st, e := c.apiErrBody("POST", "/api/auth/register", &v1.RegisterRequest{Email: uniq("thief") + "@example.com", Password: "password123",
		DisplayName: "T", InviteCode: code}); st != 403 || e.GetCode() != v1.ErrorCode_ERROR_CODE_INVITE_EMAIL_MISMATCH {
		t.Fatalf("other address with a bound code: %d %s", st, e.GetCode())
	}
	// ADR-0027: the emailed code is a sign-up code, not a proof of the address — the user
	// joins once the address is confirmed with the code of the next mail.
	u1, resp := registerRaw(t, first, code, "")
	if resp.GetMe().GetEmailVerified() {
		t.Fatal("registration with an emailed code verified the address")
	}
	if st := u1.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member before confirming the address: %d", st)
	}
	var vr v1.VerifyEmailResponse
	u1.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: nthMail(t, 1, mail.TemplateVerifyCode, first).Params["code"]}, &vr)
	if ids := vr.GetJoinedWorkspaceIds(); len(ids) != 1 || ids[0] != ws.GetId() || !vr.GetMe().GetEmailVerified() {
		t.Fatalf("verify: %v", &vr)
	}
	u1.must(200, "GET", path, nil, nil)

	// (2) Invited address registers without the link, then verifies: auto-join.
	second := uniq("inv2") + "@example.com"
	a.must(201, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: second}, nil)
	o := owner(t)
	u2, _ := registerRaw(t, second, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()), "")
	if st := u2.do("GET", path, nil, nil); st != 404 {
		t.Fatalf("member before verifying: %d", st)
	}
	vcode := nthMail(t, 1, mail.TemplateVerifyCode, second).Params["code"]
	u2.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: vcode}, nil)
	u2.must(200, "GET", path, nil, nil)
	list.Reset()
	a.must(200, "GET", path+"/invites/email", nil, &list)
	if len(list.GetInvites()) != 0 {
		t.Fatalf("accepted invitations still listed: %v", &list)
	}
	a.wantErr(409, v1.ErrorCode_ERROR_CODE_CONFLICT, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: second})

	// (3) Revoked invitation: the link is dead.
	third := uniq("inv3") + "@example.com"
	a.must(201, "POST", path+"/invites/email", &v1.CreateEmailInviteRequest{Email: third}, &created)
	tcode := nthMail(t, 1, mail.TemplateWorkspaceInvite, third).Params["url"]
	tcode = tcode[strings.LastIndex(tcode, "/")+1:]
	a.must(204, "DELETE", path+"/invites/email/"+created.GetInvite().GetId(), nil, nil)
	a.wantErr(404, v1.ErrorCode_ERROR_CODE_INVITE_INVALID, "GET", "/api/invites/"+tcode, nil)

	// Unverified callers cannot invite.
	unverified, _ := registerRaw(t, uniq("unv")+"@example.com", invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()), "")
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE workspace_members SET role = 'owner' WHERE user_id = $1", unverified.id); err != nil {
		t.Fatal(err)
	}
	var wsl v1.ListWorkspacesResponse
	unverified.must(200, "GET", "/api/workspaces", nil, &wsl)
	unverified.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/workspaces/"+wsl.GetWorkspaces()[0].GetId()+"/invites/email",
		&v1.CreateEmailInviteRequest{Email: uniq("x") + "@example.com"})
	unverified.wantErr(403, v1.ErrorCode_ERROR_CODE_EMAIL_NOT_VERIFIED, "POST", "/api/workspaces/"+wsl.GetWorkspaces()[0].GetId()+"/invites",
		&v1.CreateInviteRequest{MaxUses: 1})
}

// The outbox retries transient failures with backoff, gives up on permanent ones and
// never keeps params (codes, links) after it is done.
func TestMailOutboxRetries(t *testing.T) {
	ctx := context.Background()
	// Take the worker lock away from the app's worker for the duration of the test.
	set := func(v string) {
		_ = testRedis.Do(ctx, testRedis.B().Set().Key("mail:worker").Value(v).Ex(time.Minute).Build()).Error()
	}
	set("outbox-test")
	t.Cleanup(func() { _ = testRedis.Do(ctx, testRedis.B().Del().Key("mail:worker").Build()).Error() })
	time.Sleep(300 * time.Millisecond) // a batch the app worker may be in finishes

	fake := mail.NewFake()
	svc := mail.New(mail.Config{PerAddressPerHour: 3, PerHour: 1000, Secret: []byte(testCfg.JWTSecret)}, testDB, testRedis, fake)
	to := uniq("retry") + "@example.com"
	if err := svc.Enqueue(ctx, nil, mail.Mail{To: to, Template: mail.TemplateVerifyCode, Locale: "en", TTL: time.Hour,
		Params: mail.Params{"code": "123456", "minutes": "10"}}); err != nil {
		t.Fatal(err)
	}
	row := func() (attempts int, sent, failed bool, params bool, errText string, due bool) {
		t.Helper()
		err := testDB.Pool.QueryRow(ctx, `SELECT attempts, sent_at IS NOT NULL, failed_at IS NOT NULL, params IS NOT NULL, error, next_at <= now()
			FROM mail_outbox WHERE to_addr = $1 ORDER BY created_at DESC LIMIT 1`, to).Scan(&attempts, &sent, &failed, &params, &errText, &due)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	makeDue := func() {
		if _, err := testDB.Pool.Exec(ctx, "UPDATE mail_outbox SET next_at = now() WHERE to_addr = $1", to); err != nil {
			t.Fatal(err)
		}
	}
	fake.FailNext(2, errors.New("connection refused"))
	for i := 1; i <= 2; i++ {
		if _, err := svc.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		att, sent, failed, params, errText, due := row()
		if att != i || sent || failed || !params || !strings.Contains(errText, "refused") || due {
			t.Fatalf("after failure %d: attempts %d sent %v failed %v params %v err %q due %v", i, att, sent, failed, params, errText, due)
		}
		makeDue()
	}
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if att, sent, failed, params, _, _ := row(); att != 2 || !sent || failed || params {
		t.Fatalf("after success: attempts %d sent %v failed %v params %v", att, sent, failed, params)
	}
	if m, ok := fake.Wait(time.Second, func(m mail.Message) bool { return m.To == to }); !ok || m.Params["code"] != "123456" {
		t.Fatal("not delivered")
	}

	// A permanent SMTP error (5xx) is not retried.
	to2 := uniq("perm") + "@example.com"
	to = to2
	if err := svc.Enqueue(ctx, nil, mail.Mail{To: to, Template: mail.TemplateVerifyCode, TTL: time.Hour,
		Params: mail.Params{"code": "123456", "minutes": "10"}}); err != nil {
		t.Fatal(err)
	}
	fake.FailNext(1, &textproto.Error{Code: 550, Msg: "mailbox unavailable"})
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if att, sent, failed, params, _, _ := row(); att != 1 || sent || !failed || params {
		t.Fatalf("permanent: attempts %d sent %v failed %v params %v", att, sent, failed, params)
	}

	// A mail whose lifetime ended is dropped, not sent late.
	to = uniq("late") + "@example.com"
	if err := svc.Enqueue(ctx, nil, mail.Mail{To: to, Template: mail.TemplateVerifyCode, TTL: time.Hour,
		Params: mail.Params{"code": "123456", "minutes": "10"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := testDB.Pool.Exec(ctx, "UPDATE mail_outbox SET expires_at = now() - interval '1 second' WHERE to_addr = $1", to); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ProcessOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, sent, failed, _, _, _ := row(); sent || !failed {
		t.Fatal("expired mail was not dropped")
	}

	// Per-address budget: 3 per hour (the three mails above went to other addresses).
	to = uniq("budget") + "@example.com"
	for i := range 4 {
		err := svc.Enqueue(ctx, nil, mail.Mail{To: to, Template: mail.TemplateVerifyCode, Params: mail.Params{"code": "1", "minutes": "1"}})
		if (i < 3) != (err == nil) {
			t.Fatalf("mail %d to one address: %v", i+1, err)
		}
	}
}
