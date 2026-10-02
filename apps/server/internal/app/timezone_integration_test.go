//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// The profile time zone: validated IANA name, round-trips through PATCH /api/me, reaches
// other members (USER_UPDATE, READY member list) and can be cleared.
func TestProfileTimezone(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	// Observe this workspace with an isolated member. The shared bootstrap owner
	// accumulates unrelated workspaces across the full suite; their READY snapshots
	// are outside this profile propagation test.
	viewer := register(t, invite(t, o, ws.GetId()))
	og := dialGW(t)
	og.identify(viewer.token)
	tz := func(s string) *v1.UpdateMeRequest { return &v1.UpdateMeRequest{Timezone: &s} }

	for _, bad := range []string{"Mars/Olympus", "Local", "europe/moscow", "../../etc/passwd"} {
		bob.must(422, "PATCH", "/api/me", tz(bad), nil)
	}
	var me v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me", tz("Europe/Moscow"), &me)
	if me.GetMe().GetUser().GetTimezone() != "Europe/Moscow" {
		t.Fatalf("response: %v", me.GetMe().GetUser())
	}
	og.wait("USER_UPDATE with the time zone", func(e *v1.DispatchEvent) bool {
		u := e.GetUserUpdate().GetUser()
		return u.GetId() == bob.id && u.GetTimezone() == "Europe/Moscow"
	})
	var got v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &got)
	if got.GetMe().GetUser().GetTimezone() != "Europe/Moscow" {
		t.Fatal("GET /api/me lacks the time zone")
	}
	member := func() *v1.User {
		for _, s := range dialGW(t).identify(viewer.token).GetWorkspaces() {
			if s.GetWorkspace().GetId() != ws.GetId() {
				continue
			}
			for _, m := range s.GetMembers() {
				if m.GetUser().GetId() == bob.id {
					return m.GetUser()
				}
			}
		}
		return nil
	}
	if u := member(); u.GetTimezone() != "Europe/Moscow" {
		t.Fatalf("READY member: %v", u)
	}
	bob.must(200, "PATCH", "/api/me", tz(""), &me)
	if me.GetMe().GetUser().GetTimezone() != "" || member().GetTimezone() != "" {
		t.Fatal("time zone not cleared")
	}
}
