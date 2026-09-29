//go:build integration

package app_test

import (
	"fmt"
	"net/url"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Notes shelves (ADR-0039).

func createShelf(t *testing.T, u musty, name, emoji string, want int) *v1.NotesShelf {
	t.Helper()
	var r v1.CreateNotesResponse
	u.must(want, "POST", "/api/notes", &v1.CreateNotesRequest{Name: name, Emoji: emoji}, &r)
	return r.GetShelf()
}

func listShelves(t *testing.T, u musty) *v1.ListNotesResponse {
	t.Helper()
	var r v1.ListNotesResponse
	u.must(200, "GET", "/api/notes", nil, &r)
	return &r
}

// notesTeam: a fresh member (the shared owner would carry shelves between tests), a peer and
// the workspace owner.
func notesTeam(t *testing.T) (me, bob, o *user, ws *v1.Workspace) {
	t.Helper()
	o = owner(t)
	ws = createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	return register(t, invite(t, o, ws.GetId())), register(t, invite(t, o, ws.GetId())), o, ws
}

// TestNotesShelves: CRUD with events on the owner's devices, the room endpoints in a shelf
// (messages, pins, reactions, search), the cap of 20, no voice, another user sees nothing.
func TestNotesShelves(t *testing.T) {
	o, bob, _, _ := notesTeam(t)
	g := dialGW(t)
	g.identify(o.token)

	a := createShelf(t, o, "  Идеи  ", "💡", 201)
	room := a.GetRoom()
	if room.GetType() != v1.RoomType_ROOM_TYPE_NOTES || room.GetName() != "Идеи" || a.GetEmoji() != "💡" || room.GetWorkspaceId() != "" || room.GetPosition() != 0 {
		t.Fatalf("created shelf: %v", a)
	}
	g.wait("NOTES_CREATE", func(e *v1.DispatchEvent) bool { return e.GetNotesCreate().GetShelf().GetRoom().GetId() == room.GetId() })
	b := createShelf(t, o, "Ссылки", "", 201)
	if b.GetRoom().GetPosition() != 1 {
		t.Fatalf("second shelf position %d", b.GetRoom().GetPosition())
	}
	createShelf(t, o, "", "", 422)
	createShelf(t, o, "12345678901234567890123456789012345678901", "", 422) // 41 characters
	createShelf(t, o, "x", "abc", 422)

	// Messages, pins, reactions and search go through the room endpoints.
	m := send(t, o, room.GetId(), "купить молоко", uniq("n"))
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
	var found v1.ListMessagesResponse
	o.must(200, "GET", "/api/rooms/"+room.GetId()+"/messages?q="+url.QueryEscape("молоко"), nil, &found)
	if len(found.GetMessages()) != 1 || found.GetMessages()[0].GetId() != m.GetId() {
		t.Fatalf("search in a shelf: %v", found.GetMessages())
	}
	g.wait("MESSAGE_CREATE of the shelf", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetId() == m.GetId() && e.GetMessageCreate().GetWorkspaceId() == ""
	})
	l := listShelves(t, o)
	if len(l.GetShelves()) != 2 || l.GetShelves()[0].GetLastMessage().GetId() != m.GetId() || l.GetStorage().GetQuotaBytes() != 1<<30 || !l.GetStorage().GetIsDefault() {
		t.Fatalf("list: %v", l)
	}
	g = dialGW(t) // replaces the first session
	if ready := g.identify(o.token); len(ready.GetNotes()) != 2 || ready.GetNotes()[0].GetRoom().GetId() != room.GetId() {
		t.Fatalf("READY notes: %v", ready.GetNotes())
	}

	// Rename, emoji, move: the moved shelves get NOTES_UPDATE.
	name, emoji, pos := "Мысли", "", uint32(1)
	var up v1.UpdateNotesResponse
	o.must(200, "PATCH", "/api/notes/"+room.GetId(), &v1.UpdateNotesRequest{Name: &name, Emoji: &emoji, Position: &pos}, &up)
	if up.GetShelf().GetRoom().GetName() != "Мысли" || up.GetShelf().GetEmoji() != "" || up.GetShelf().GetRoom().GetPosition() != 1 {
		t.Fatalf("update: %v", up.GetShelf())
	}
	g.wait("NOTES_UPDATE of the other shelf", func(e *v1.DispatchEvent) bool {
		s := e.GetNotesUpdate().GetShelf()
		return s.GetRoom().GetId() == b.GetRoom().GetId() && s.GetRoom().GetPosition() == 0
	})

	// Nobody else: 404 everywhere (existence not revealed); no voice in a shelf.
	bob.must(404, "PATCH", "/api/notes/"+room.GetId(), &v1.UpdateNotesRequest{Name: &name}, nil)
	bob.must(404, "DELETE", "/api/notes/"+room.GetId(), nil, nil)
	bob.must(404, "GET", "/api/rooms/"+room.GetId()+"/messages", nil, nil)
	bob.must(404, "POST", "/api/rooms/"+room.GetId()+"/messages", &v1.CreateMessageRequest{Content: "hi", Nonce: uniq("x")}, nil)
	bob.must(404, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+url.PathEscape("👍"), nil, nil)
	if n := len(listShelves(t, bob).GetShelves()); n != 0 {
		t.Fatalf("bob sees %d shelves", n)
	}
	o.must(404, "POST", "/api/rooms/"+room.GetId()+"/join", nil, nil)
	o.must(404, "POST", "/api/dms/"+room.GetId()+"/call", nil, nil)
	o.must(404, "PATCH", "/api/dms/"+room.GetId()+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)
	var dms v1.ListDmsResponse
	o.must(200, "GET", "/api/dms", nil, &dms)
	for _, d := range dms.GetDms() {
		if d.GetRoom().GetId() == room.GetId() {
			t.Fatal("a shelf is listed as a DM")
		}
	}

	// Delete: messages go with it; the other devices learn it.
	o.must(204, "DELETE", "/api/notes/"+room.GetId(), nil, nil)
	g.wait("NOTES_DELETE", func(e *v1.DispatchEvent) bool { return e.GetNotesDelete().GetRoomId() == room.GetId() })
	o.must(404, "GET", "/api/rooms/"+room.GetId()+"/messages", nil, nil)
	o.must(404, "DELETE", "/api/notes/"+room.GetId(), nil, nil)

	// The cap: 20 shelves (one exists).
	for i := range 19 {
		createShelf(t, o, fmt.Sprintf("Полка %d", i), "", 201)
	}
	createShelf(t, o, "лишняя", "", 409)
	if reason, _ := errReason(o.client); reason != "NOTES_LIMIT" {
		t.Fatalf("limit reason %q", reason)
	}
}

// TestNotesBotsAndGuests: /api/notes is for people only (403), READY carries no shelves.
func TestNotesBotsAndGuests(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	bt := createBot(t, o, ws.GetId(), "notesbot")
	bt.must(403, "GET", "/api/notes", nil, nil)
	bt.must(403, "POST", "/api/notes", &v1.CreateNotesRequest{Name: "x"}, nil)

	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.64.1.1"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.64.1.2"}, id: gj.GetMe().GetUser().GetId()}
	guest.must(403, "GET", "/api/notes", nil, nil)
	guest.must(403, "POST", "/api/notes", &v1.CreateNotesRequest{Name: "x"}, nil)
	if ready := dialGW(t).identify(guest.token); len(ready.GetNotes()) != 0 {
		t.Fatalf("guest READY has shelves: %v", ready.GetNotes())
	}
	// A bot cannot reach someone's shelf through the room endpoints either.
	me := register(t, invite(t, o, ws.GetId()))
	s := createShelf(t, me, "Личное", "", 201)
	bt.must(404, "GET", "/api/rooms/"+s.GetRoom().GetId()+"/messages", nil, nil)
}

// TestNotesForward (ADR-0033 both ways): a room message into a shelf and a shelf message into
// a DM; the copy from a shelf does not disclose it; the files stay readable through the copy.
func TestNotesForward(t *testing.T) {
	o, bob, owner, ws := notesTeam(t)
	general := textRoom(t, owner, ws.GetId(), "general", false)
	shelf := createShelf(t, o, "Входящие", "📥", 201).GetRoom().GetId()
	dm := openDM(t, o, bob.id, 201).GetRoom().GetId()

	src := send(t, bob, general, "протокол встречи", uniq("f"))
	in := forwardMsg(t, o, general, src.GetId(), shelf, 201)
	if in.GetRoomId() != shelf || in.GetForward().GetRoomId() != general || in.GetForward().GetAuthorId() != bob.id {
		t.Fatalf("into the shelf: %v", in)
	}
	forwardMsg(t, bob, general, src.GetId(), shelf, 404) // not bob's shelf

	_, f, _ := upload(t, o, "/api/dms/"+shelf+"/files", "plan.png", pngBytes(8, 8))
	var mine v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+shelf+"/messages", &v1.CreateMessageRequest{Content: "черновик", AttachmentIds: []string{f.GetId()}, Nonce: uniq("n")}, &mine)
	if st := fileStatus(t, bob, f.GetId()); st != 404 {
		t.Fatalf("bob reads a shelf file: %d", st)
	}
	out := forwardMsg(t, o, shelf, mine.GetMessage().GetId(), dm, 201)
	if out.GetForward().GetRoomId() != "" || len(out.GetAttachments()) != 1 {
		t.Fatalf("out of the shelf: %v", out)
	}
	if st := fileStatus(t, bob, f.GetId()); st != 200 {
		t.Fatalf("bob reads the file through the DM copy: %d", st)
	}
	forwardMsg(t, bob, shelf, mine.GetMessage().GetId(), dm, 404) // bob cannot read the shelf
}

// TestNotesPersonalQuota (ADR-0039 §5): uploads into a shelf count against the personal quota
// set by a superadmin; DMs are not limited by it; forwarding into a shelf costs nothing.
func TestNotesPersonalQuota(t *testing.T) {
	o, bob, _, _ := notesTeam(t)
	sa := superadminUser(t)
	shelf := createShelf(t, o, "Файлы", "", 201).GetRoom().GetId()
	dm := openDM(t, o, bob.id, 201).GetRoom().GetId()
	path := "/api/admin/users/" + o.id + "/storage-quota"
	o.must(404, "PUT", path, &v1.SetUserStorageQuotaRequest{}, nil) // superadmins only

	zero := uint64(0)
	var q v1.UserStorageQuota
	sa.must(200, "PUT", path, &v1.SetUserStorageQuotaRequest{QuotaBytes: &zero}, &q)
	if q.GetQuotaBytes() != 0 || q.GetIsDefault() {
		t.Fatalf("quota: %v", &q)
	}
	if st, _, _ := upload(t, o, "/api/dms/"+shelf+"/files", "a.png", pngBytes(8, 8)); st != 413 {
		t.Fatalf("upload over the quota: %d", st)
	}
	st, df, _ := upload(t, o, "/api/dms/"+dm+"/files", "a.png", pngBytes(8, 8))
	if st != 201 {
		t.Fatalf("DM upload with a zero personal quota: %d", st)
	}
	o.must(201, "POST", "/api/rooms/"+dm+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{df.GetId()}, Nonce: uniq("q")}, nil)
	// Room forwarding into a shelf does not count.
	_, f, _ := upload(t, bob, "/api/dms/"+dm+"/files", "b.png", pngBytes(8, 8))
	var dmMsg v1.CreateMessageResponse
	bob.must(201, "POST", "/api/rooms/"+dm+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{f.GetId()}, Nonce: uniq("q")}, &dmMsg)
	forwardMsg(t, o, dm, dmMsg.GetMessage().GetId(), shelf, 201)

	big := uint64(1 << 20)
	sa.must(200, "PUT", path, &v1.SetUserStorageQuotaRequest{QuotaBytes: &big}, nil)
	st, file, _ := upload(t, o, "/api/dms/"+shelf+"/files", "c.png", pngBytes(8, 8))
	if st != 201 {
		t.Fatalf("upload within the quota: %d", st)
	}
	o.must(201, "POST", "/api/rooms/"+shelf+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{file.GetId()}, Nonce: uniq("q")}, nil)
	used := listShelves(t, o).GetStorage().GetUsedBytes()
	if used != file.GetSize() {
		t.Fatalf("used %d, want %d (the DM upload and the forwarded file do not count)", used, file.GetSize())
	}
	// Back to the default.
	sa.must(200, "PUT", path, &v1.SetUserStorageQuotaRequest{}, &q)
	if !q.GetIsDefault() || q.GetQuotaBytes() != 1<<30 {
		t.Fatalf("reset: %v", &q)
	}
}
