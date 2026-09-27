//go:build integration

package app_test

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func dmPost(t *testing.T, u *user, rid, text string) *v1.Message {
	t.Helper()
	var cm v1.CreateMessageResponse
	u.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: text}, &cm)
	return cm.GetMessage()
}

func dmOf(t *testing.T, u *user, rid string) *v1.DmSummary {
	t.Helper()
	var dl v1.ListDmsResponse
	u.must(200, "GET", "/api/dms", nil, &dl)
	for _, d := range dl.GetDms() {
		if d.GetRoom().GetId() == rid {
			return d
		}
	}
	t.Fatalf("DM %s not in the list", rid)
	return nil
}

func history(t *testing.T, u *user, rid, query string) []string {
	t.Helper()
	var list v1.ListMessagesResponse
	u.must(200, "GET", "/api/rooms/"+rid+"/messages"+query, nil, &list)
	out := make([]string, len(list.GetMessages()))
	for i, m := range list.GetMessages() {
		out[i] = m.GetContent()
	}
	return out
}

// TestDmArchiveAndDelete covers docs/09 item 51: PATCH /api/dms/{id}/state archives for the
// caller only, an incoming message un-archives with DM_STATE_UPDATE, «Удалить чат» hides the
// history and counts for the caller only, and only participants may change the state.
func TestDmArchiveAndDelete(t *testing.T) {
	o, bob, _, _ := setupTeam(t)
	rid := openDM(t, o, bob.id, 201).GetRoom().GetId()
	m1 := dmPost(t, bob, rid, "first")
	dmPost(t, bob, rid, "second")

	og := dialGW(t)
	og.identify(o.token)

	// Validation and access: nothing set 422; unknown / someone else's DM 404.
	o.must(422, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{}, nil)
	o.must(404, "PATCH", "/api/dms/not-an-id/state", &v1.UpdateDmStateRequest{Archived: ptr(true)}, nil)
	o.must(404, "PATCH", "/api/dms/00000000-0000-7000-8000-000000000000/state", &v1.UpdateDmStateRequest{Archived: ptr(true)}, nil)
	carol := register(t, invite(t, o, createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	carol.must(404, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Archived: ptr(true)}, nil)
	carol.must(404, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)

	// Archive: o's answer, o's devices and o's list have archived_at; bob's DM does not.
	var ur v1.UpdateDmStateResponse
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Archived: ptr(true)}, &ur)
	if ur.GetDm().GetArchivedAt() == nil || ur.GetDm().GetRoom().GetId() != rid {
		t.Fatalf("archive answer: %v", &ur)
	}
	og.wait("DM_STATE_UPDATE (archived)", func(e *v1.DispatchEvent) bool {
		return e.GetDmStateUpdate().GetRoomId() == rid && e.GetDmStateUpdate().GetArchivedAt() != nil
	})
	if dmOf(t, o, rid).GetArchivedAt() == nil || dmOf(t, bob, rid).GetArchivedAt() != nil {
		t.Fatal("archive must be the caller's only")
	}
	og = dialGW(t) // the same token's new session replaces the old one
	if ready := og.identify(o.token); !func() bool {
		for _, d := range ready.GetDms() {
			if d.GetRoom().GetId() == rid {
				return d.GetArchivedAt() != nil
			}
		}
		return false
	}() {
		t.Fatal("READY.dms lacks archived_at")
	}

	// o's own message keeps the archive; bob's incoming one takes it out (DM_STATE_UPDATE).
	dmPost(t, o, rid, "from o")
	if dmOf(t, o, rid).GetArchivedAt() == nil {
		t.Fatal("an own message un-archived the DM")
	}
	dmPost(t, bob, rid, "third")
	og.wait("DM_STATE_UPDATE (un-archived)", func(e *v1.DispatchEvent) bool {
		return e.GetDmStateUpdate().GetRoomId() == rid && e.GetDmStateUpdate().GetArchivedAt() == nil
	})
	if d := dmOf(t, o, rid); d.GetArchivedAt() != nil || d.GetReadState().GetUnreadCount() != 1 {
		t.Fatalf("after an incoming message: %v", d)
	}
	// Explicit un-archive is idempotent.
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Archived: ptr(false)}, nil)

	// «Удалить чат» for o: history, preview, counts, pins and search start after the mark.
	bob.must(204, "PUT", "/api/messages/"+m1.GetId()+"/pin", nil, nil)
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Archived: ptr(true)}, nil)
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Cleared: true}, &ur)
	cleared := ur.GetDm()
	if cleared.GetClearedBeforeMessageId() == "" || cleared.GetArchivedAt() != nil || cleared.GetLastMessage() != nil ||
		cleared.GetReadState().GetUnreadCount() != 0 {
		t.Fatalf("cleared DM: %v", cleared)
	}
	og.wait("DM_STATE_UPDATE (cleared)", func(e *v1.DispatchEvent) bool {
		return e.GetDmStateUpdate().GetClearedBeforeMessageId() == cleared.GetClearedBeforeMessageId()
	})
	if h := history(t, o, rid, ""); len(h) != 0 {
		t.Fatalf("o's history after clearing: %v", h)
	}
	if h := history(t, o, rid, "?after="+m1.GetId()); len(h) != 0 {
		t.Fatalf("o's history after= a hidden id: %v", h)
	}
	if h := history(t, o, rid, "?q=first"); len(h) != 0 {
		t.Fatalf("o's search after clearing: %v", h)
	}
	var pins v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+rid+"/pins", nil, &pins)
	if len(pins.GetMessages()) != 0 {
		t.Fatalf("o's pins after clearing: %v", pins.GetMessages())
	}
	bob.must(200, "GET", "/api/rooms/"+rid+"/pins", nil, &pins)
	if len(pins.GetMessages()) != 1 {
		t.Fatalf("bob's pins changed: %v", pins.GetMessages())
	}
	// bob keeps everything: history, pins, search, his own read state and counts.
	bobBefore := dmOf(t, bob, rid)
	if h := history(t, bob, rid, ""); len(h) != 4 {
		t.Fatalf("bob's history changed: %v", h)
	}
	if h := history(t, bob, rid, "?q=first"); len(h) != 1 {
		t.Fatalf("bob's search changed: %v", h)
	}
	if bobBefore.GetClearedBeforeMessageId() != "" || bobBefore.GetLastMessage().GetContent() != "third" ||
		bobBefore.GetReadState().GetUnreadCount() != 0 { // his «third» read «from o»
		t.Fatalf("bob's DM changed: %v", bobBefore)
	}

	// A new message after clearing: o sees only it, one unread.
	dmPost(t, bob, rid, "fresh")
	d := dmOf(t, o, rid)
	if d.GetLastMessage().GetContent() != "fresh" || d.GetReadState().GetUnreadCount() != 1 {
		t.Fatalf("after a new message: %v", d)
	}
	if h := history(t, o, rid, ""); len(h) != 1 || h[0] != "fresh" {
		t.Fatalf("o's history after a new message: %v", h)
	}
}
