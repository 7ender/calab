//go:build integration

package app_test

import (
	"testing"

	"github.com/coder/websocket"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// docs/09 #143: the client of the most recently identified session goes to others in
// PRESENCE_UPDATE and READY presences; when it leaves, the previous one shows again.
func TestPresenceClientVersion(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	og := dialGW(t)
	og.identify(o.token)
	identify := func(g *gw, token, platform, version string) {
		t.Helper()
		g.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_IDENTIFY, Payload: &v1.GatewayFrame_Identify{Identify: &v1.Identify{
			Token: token, Device: &v1.DeviceInfo{Name: "x", Platform: platform, AppVersion: version},
		}}})
		g.wait("READY", func(e *v1.DispatchEvent) bool { return e.GetReady() != nil })
	}
	seen := func(what, platform, version string, st v1.PresenceStatus) {
		t.Helper()
		og.wait(what, func(e *v1.DispatchEvent) bool {
			p := e.GetPresenceUpdate().GetPresence()
			return p.GetUserId() == bob.id && p.GetStatus() == st && p.GetClientPlatform() == platform && p.GetClientVersion() == version
		})
	}
	d1 := dialGW(t)
	identify(d1, bob.token, "darwin", "1.0.0")
	seen("desktop 1.0.0", "darwin", "1.0.0", v1.PresenceStatus_PRESENCE_STATUS_ONLINE)

	var l v1.LoginResponse
	c := &client{t: t, ip: "10.64.0.1"}
	c.must(200, "POST", "/api/auth/login", &v1.LoginRequest{Email: mustEmail(t, bob), Password: "password123"}, &l)
	d2 := dialGW(t)
	identify(d2, l.GetTokens().GetAccessToken(), "web", "1.1.0")
	seen("web 1.1.0 wins", "web", "1.1.0", v1.PresenceStatus_PRESENCE_STATUS_ONLINE)

	// A new READY carries it in the workspace presences.
	og2 := dialGW(t)
	var got *v1.Presence
	for _, w := range og2.identify(o.token).GetWorkspaces() {
		for _, p := range w.GetPresences() {
			if p.GetUserId() == bob.id {
				got = p
			}
		}
	}
	if got.GetClientPlatform() != "web" || got.GetClientVersion() != "1.1.0" {
		t.Fatalf("READY presence: %v", got)
	}

	// The newest session leaves: the desktop one shows again.
	_ = d2.ws.Close(websocket.StatusNormalClosure, "bye")
	og2.wait("back to desktop", func(e *v1.DispatchEvent) bool {
		p := e.GetPresenceUpdate().GetPresence()
		return p.GetUserId() == bob.id && p.GetClientPlatform() == "darwin" && p.GetClientVersion() == "1.0.0"
	})
}
