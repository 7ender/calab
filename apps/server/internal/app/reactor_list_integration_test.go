//go:build integration

package app_test

import (
	"net/url"
	"slices"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestReactorList: GET /api/messages/{id}/reactions/{emoji} — the reaction tooltip's source
// (issue #32). VIEW_ROOM of the message's room is required and the message must be in the
// caller's visible history (deleted, a foreign DM and the cleared slice of a DM answer 404
// like the message itself); pages are a keyset by user id (`after` = the last id of a page).
func TestReactorList(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	carol := register(t, invite(t, o, ws.GetId()))
	path := func(mid, e string) string { return "/api/messages/" + mid + "/reactions/" + url.PathEscape(e) }
	list := func(u *user, mid, suffix string) *v1.ListReactionUsersResponse {
		t.Helper()
		var r v1.ListReactionUsersResponse
		u.must(200, "GET", path(mid, "👍")+suffix, nil, &r)
		return &r
	}
	ids := func(r *v1.ListReactionUsersResponse) []string {
		out := make([]string, 0, len(r.GetUsers()))
		for _, u := range r.GetUsers() {
			out = append(out, u.GetId())
		}
		return out
	}

	// Everyone reacts with 👍; bob also with ❤️.
	mid := send(t, o, room.GetId(), "reactor list", "").GetId()
	for _, u := range []*user{o, bob, carol} {
		u.must(204, "PUT", path(mid, "👍"), nil, nil)
	}
	bob.must(204, "PUT", path(mid, "❤️"), nil, nil)

	// All three reactors, ordered by user id, each with the public profile.
	want := []string{o.id, bob.id, carol.id}
	slices.Sort(want)
	got := list(bob, mid, "")
	if !slices.Equal(ids(got), want) || got.GetHasMore() {
		t.Fatalf("reactors: %v, want %v (hasMore %v)", ids(got), want, got.GetHasMore())
	}
	for _, u := range got.GetUsers() {
		if u.GetDisplayName() == "" {
			t.Fatalf("a reactor without a profile: %v", u)
		}
	}

	// A different emoji carries only its own reactors; an unused one is an empty page.
	var heart v1.ListReactionUsersResponse
	bob.must(200, "GET", path(mid, "❤️"), nil, &heart)
	if !slices.Equal(ids(&heart), []string{bob.id}) {
		t.Fatalf("❤️ reactors: %v", ids(&heart))
	}
	var none v1.ListReactionUsersResponse
	bob.must(200, "GET", path(mid, "🎉"), nil, &none)
	if len(none.GetUsers()) != 0 || none.GetHasMore() {
		t.Fatalf("unused emoji: %v", ids(&none))
	}

	// Keyset pagination by user id: limit 2 leaves exactly the third reactor for page 2.
	p1 := list(o, mid, "?limit=2")
	if len(p1.GetUsers()) != 2 || !p1.GetHasMore() || !slices.Equal(ids(p1), want[:2]) {
		t.Fatalf("page 1: %v", ids(p1))
	}
	p2 := list(o, mid, "?limit=2&after="+p1.GetUsers()[1].GetId())
	if len(p2.GetUsers()) != 1 || p2.GetHasMore() || p2.GetUsers()[0].GetId() != want[2] {
		t.Fatalf("page 2: %v", ids(p2))
	}
	if r := list(o, mid, "?limit=3&after="+want[2]); len(r.GetUsers()) != 0 || r.GetHasMore() {
		t.Fatalf("after the last reactor: %v", ids(r))
	}
	o.must(400, "GET", path(mid, "👍")+"?limit=0", nil, nil)
	o.must(400, "GET", path(mid, "👍")+"?limit=101", nil, nil)
	o.must(400, "GET", path(mid, "👍")+"?after=nope", nil, nil)
	o.must(422, "GET", "/api/messages/"+mid+"/reactions/ab", nil, nil)

	// Outsiders see nothing: a member of another workspace, and a non-participant of a DM.
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	outsider := register(t, invite(t, o, ws2.GetId()))
	outsider.must(404, "GET", path(mid, "👍"), nil, nil)
	dm := openDM(t, o, carol.id, 201)
	dmid := send(t, o, dm.GetRoom().GetId(), "dm", "").GetId()
	carol.must(204, "PUT", path(dmid, "👍"), nil, nil)
	if r := list(carol, dmid, ""); !slices.Equal(ids(r), []string{carol.id}) {
		t.Fatalf("dm reactors: %v", ids(r))
	}
	bob.must(404, "GET", path(dmid, "👍"), nil, nil) // in the workspace, but not in this DM
	outsider.must(404, "GET", path(dmid, "👍"), nil, nil)

	// carol's cleared slice hides the message (docs/09 #51) — for her only; a deleted message
	// is gone for everyone.
	carol.must(200, "PATCH", "/api/dms/"+dm.GetRoom().GetId()+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)
	carol.must(404, "GET", path(dmid, "👍"), nil, nil)
	o.must(200, "GET", path(dmid, "👍"), nil, &v1.ListReactionUsersResponse{})
	o.must(204, "DELETE", "/api/messages/"+mid, nil, nil)
	bob.must(404, "GET", path(mid, "👍"), nil, nil)
}
