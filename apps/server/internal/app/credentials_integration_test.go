//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/mail"
)

func TestChangeCredentials(t *testing.T) {
	o, bob, _, room := setupTeam(t)
	email := mustEmail(t, bob)
	// A second device of bob: it is revoked by the password change.
	second := &client{t: t, ip: "10.63.0.1"}
	var l v1.LoginResponse
	second.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, &l)
	second.token = l.GetTokens().GetAccessToken()
	bg := dialGW(t)
	bg.identify(bob.token)

	bob.must(403, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "wrong-pass", NewPassword: "newpassword1"}, nil)
	bob.must(422, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "password123", NewPassword: "short"}, nil)
	bob.must(204, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "password123", NewPassword: "newpassword1"}, nil)
	second.must(401, "GET", "/api/me", nil, nil) // other session revoked at once (Redis marker)
	bob.must(200, "GET", "/api/me", nil, nil)    // this one stays
	anon := &client{t: t, ip: "10.63.0.2"}
	anon.must(401, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "password123"}, nil)
	anon.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: email, Password: "newpassword1"}, nil)

	// Email: unique (case-insensitive), password required; own devices get USER_UPDATE {me}.
	bob.must(409, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: mustEmail(t, o), CurrentPassword: "newpassword1"}, nil)
	bob.must(422, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: "not an email", CurrentPassword: "newpassword1"}, nil)
	newEmail := uniq("moved") + "@Example.com"
	var me v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: newEmail, CurrentPassword: "newpassword1"}, &me)
	// ADR-0023: the new address is pending until its code is confirmed.
	if me.GetMe().GetEmail() != email || me.GetMe().GetPendingEmail() != newEmail {
		t.Fatalf("email: %q pending %q", me.GetMe().GetEmail(), me.GetMe().GetPendingEmail())
	}
	bg.wait("USER_UPDATE me (pending)", func(e *v1.DispatchEvent) bool { return e.GetUserUpdate().GetMe().GetPendingEmail() == newEmail })
	code := nthMail(t, 1, mail.TemplateVerifyCode, newEmail).Params["code"]
	bob.must(200, "POST", "/api/auth/verify", &v1.VerifyEmailRequest{Code: code}, &me)
	if me.GetMe().GetEmail() != newEmail {
		t.Fatalf("email: %q", me.GetMe().GetEmail())
	}
	bg.wait("USER_UPDATE me", func(e *v1.DispatchEvent) bool { return e.GetUserUpdate().GetMe().GetEmail() == newEmail })
	anon.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: newEmail, Password: "newpassword1"}, nil)

	// Per-account limit: 5 password checks per 15 minutes (wrong, ok, 409, ok above; malformed
	// requests do not count): the 5th check runs, the 6th is throttled.
	bob.must(403, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "wrong-pass", NewPassword: "newpassword2"}, nil)
	bob.must(429, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: uniq("x") + "@example.com", CurrentPassword: "newpassword1"}, nil)

	// Guests have neither password nor email.
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	var gj v1.JoinRoomInviteResponse
	(&client{t: t, ip: "10.63.0.3"}).must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.63.0.4"}
	guest.must(403, "PATCH", "/api/me/password", &v1.ChangePasswordRequest{CurrentPassword: "x", NewPassword: "newpassword1"}, nil)
	guest.must(403, "PATCH", "/api/me/email", &v1.ChangeEmailRequest{NewEmail: uniq("g") + "@example.com", CurrentPassword: "x"}, nil)
}
