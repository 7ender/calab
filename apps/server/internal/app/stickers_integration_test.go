//go:build integration

package app_test

import (
	"bytes"
	"context"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// stickerFile is one part of a batch upload.
type stickerFile struct {
	emoji, name string
	data        []byte
}

func stickerFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "stickers", "testdata", name)) //nolint:gosec // test fixture
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// uploadStickers posts a multipart batch ("emoji" before each "file").
func uploadStickers(t *testing.T, u *user, packID string, fs ...stickerFile) (int, *v1.UploadStickersResponse, *v1.ApiError) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, f := range fs {
		if f.emoji != "" {
			_ = mw.WriteField("emoji", f.emoji)
		}
		fw, _ := mw.CreateFormFile("file", f.name)
		_, _ = fw.Write(f.data)
	}
	_ = mw.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "POST", srv.URL+"/api/sticker-packs/"+packID+"/stickers", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+u.token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var out v1.UploadStickersResponse
	var e v1.ApiError
	if resp.StatusCode < 300 {
		if err := protojson.Unmarshal(raw, &out); err != nil {
			t.Fatalf("decode %s: %v", raw, err)
		}
	} else {
		_ = protojson.Unmarshal(raw, &e)
	}
	return resp.StatusCode, &out, &e
}

func createPack(t *testing.T, u *user, wsID, name string) *v1.StickerPack {
	t.Helper()
	var r v1.StickerPackResponse
	u.must(201, "POST", "/api/workspaces/"+wsID+"/sticker-packs", &v1.CreateStickerPackRequest{Name: name}, &r)
	return r.GetPack()
}

// stickerTeam: owner, admin, member, guest (sees and writes in room by an override) and a
// custom role with MANAGE_STICKERS; a text room.
func stickerTeam(t *testing.T) (ws *v1.Workspace, room string, actors map[string]*user) {
	t.Helper()
	o := owner(t)
	ws = createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	var inv v1.CreateInviteResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/invites", &v1.CreateInviteRequest{MaxUses: 100}, &inv)
	code := inv.GetInvite().GetCode()
	admin, mem, guest, mgr := register(t, code), register(t, code), register(t, code), register(t, code)
	adminRole, guestRole := v1.WorkspaceRole_WORKSPACE_ROLE_ADMIN, v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+admin.id, &v1.UpdateMemberRequest{Role: &adminRole}, nil)
	o.must(200, "PATCH", "/api/workspaces/"+wid+"/members/"+guest.id, &v1.UpdateMemberRequest{Role: &guestRole}, nil)
	r := newRole(t, o, wid, "stickers", perm.ManageStickers)
	if st, _ := setMemberRoles(o, wid, mgr.id, r.GetId()); st != 200 {
		t.Fatalf("assign sticker role: %d", st)
	}
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "chat"}, &cr)
	room = cr.GetRoom().GetId()
	o.must(200, "PUT", "/api/rooms/"+room+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(guest.id, perm.ViewRoom|perm.SendMessages, 0),
	}}, nil)
	return ws, room, map[string]*user{"owner": o, "admin": admin, "member": mem, "guest": guest, "mgr": mgr}
}

// outsider is a user of another workspace only.
func outsider(t *testing.T) *user {
	t.Helper()
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	return register(t, invite(t, o, ws.GetId()))
}

// TestStickerPermissions: MANAGE_STICKERS (owner / admin through ADMINISTRATOR, a custom role)
// manages packs; members and guests only see them; outsiders get 404; the bit is
// workspace-level (422 in room overrides).
func TestStickerPermissions(t *testing.T) {
	ws, room, a := stickerTeam(t)
	wid := ws.GetId()
	stranger := outsider(t)
	for name, want := range map[string]int{"owner": 201, "admin": 201, "mgr": 201, "member": 403, "guest": 403} {
		if st := a[name].do("POST", "/api/workspaces/"+wid+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "by " + name}, nil); st != want {
			t.Errorf("create as %s: %d, want %d", name, st, want)
		}
	}
	stranger.must(404, "POST", "/api/workspaces/"+wid+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "x"}, nil)
	for _, name := range []string{"owner", "member", "guest"} {
		var l v1.ListStickerPacksResponse
		a[name].must(200, "GET", "/api/workspaces/"+wid+"/sticker-packs", nil, &l)
		if len(l.GetPacks()) != 3 {
			t.Fatalf("%s sees %d packs", name, len(l.GetPacks()))
		}
	}
	stranger.must(404, "GET", "/api/workspaces/"+wid+"/sticker-packs", nil, nil)

	p := createPack(t, a["mgr"], wid, "Cats")
	newName := "Dogs"
	a["member"].must(403, "PATCH", "/api/sticker-packs/"+p.GetId(), &v1.UpdateStickerPackRequest{Name: &newName}, nil)
	stranger.must(404, "PATCH", "/api/sticker-packs/"+p.GetId(), &v1.UpdateStickerPackRequest{Name: &newName}, nil)
	a["mgr"].must(200, "PATCH", "/api/sticker-packs/"+p.GetId(), &v1.UpdateStickerPackRequest{Name: &newName}, nil)
	if st, _, _ := uploadStickers(t, a["member"], p.GetId(), stickerFile{"😺", "a.webp", stickerFixture(t, "sun.webp")}); st != 403 {
		t.Fatalf("member upload: %d", st)
	}
	// Short names are unique among the workspace's live packs.
	a["owner"].must(201, "POST", "/api/workspaces/"+wid+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "S", ShortName: "same"}, nil)
	a["owner"].must(409, "POST", "/api/workspaces/"+wid+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "S2", ShortName: "same"}, nil)
	a["owner"].must(422, "POST", "/api/workspaces/"+wid+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "S3", ShortName: "Bad Name!"}, nil)

	// Workspace-level only: not settable per room.
	a["owner"].must(422, "PUT", "/api/rooms/"+room+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(a["member"].id, perm.ManageStickers, 0),
	}}, nil)
	a["member"].must(403, "DELETE", "/api/sticker-packs/"+p.GetId(), nil, nil)
	a["mgr"].must(204, "DELETE", "/api/sticker-packs/"+p.GetId(), nil, nil)
	a["mgr"].must(404, "DELETE", "/api/sticker-packs/"+p.GetId(), nil, nil)
}

// TestStickerUploadValidation: WebP only (RIFF/WEBP, known chunks, sides ≤ 512), an emoji per
// sticker, all or nothing per batch; the file is served as image/webp with nosniff to members.
func TestStickerUploadValidation(t *testing.T) {
	ws, _, a := stickerTeam(t)
	o := a["owner"]
	p := createPack(t, o, ws.GetId(), "Shapes")
	sun, gem, orbit := stickerFixture(t, "sun.webp"), stickerFixture(t, "gem.webp"), stickerFixture(t, "orbit.webp")
	st, up, e := uploadStickers(t, o, p.GetId(), stickerFile{"☀️", "sun.webp", sun}, stickerFile{"💎", "gem.webp", gem}, stickerFile{"🌀", "orbit.webp", orbit})
	if st != 201 || len(up.GetAdded()) != 3 || len(up.GetPack().GetStickers()) != 3 {
		t.Fatalf("upload: %d %v %v", st, up, e)
	}
	got := up.GetPack().GetStickers()
	if got[0].GetEmoji() != "☀️" || got[0].GetAnimated() || !got[2].GetAnimated() || got[2].GetWidth() != 160 || int(got[1].GetSize()) != len(gem) {
		t.Fatalf("stickers: %v", got)
	}
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	html := []byte("<!doctype html><script>alert(1)</script>")
	for name, fs := range map[string][]stickerFile{
		"too large side": {{"🟥", "big.webp", stickerFixture(t, "big.webp")}},
		"png":            {{"🖼️", "x.webp", png}},
		"html":           {{"📄", "x.webp", html}},
		"no emoji":       {{"", "sun.webp", sun}},
		"text emoji":     {{"abc", "sun.webp", sun}},
		"second bad":     {{"☀️", "sun.webp", sun}, {"📄", "x.webp", html}},
	} {
		if st, _, e := uploadStickers(t, o, p.GetId(), fs...); st != 422 {
			t.Errorf("%s: %d %v", name, st, e)
		}
	}
	var l v1.ListStickerPacksResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId()+"/sticker-packs", nil, &l)
	if n := len(l.GetPacks()[0].GetStickers()); n != 3 {
		t.Fatalf("after rejected batches: %d stickers", n)
	}

	// Download: members (the guest too) get image/webp + nosniff; outsiders 404.
	get := func(u *user, path string) (int, http.Header) {
		req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+path, http.NoBody)
		req.Header.Set("Authorization", "Bearer "+u.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode, resp.Header
	}
	for _, name := range []string{"member", "guest"} {
		st, h := get(a[name], got[2].GetUrl())
		if st != 200 || h.Get("Content-Type") != "image/webp" || h.Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("%s download: %d %v", name, st, h)
		}
	}
	if st, _ := get(outsider(t), got[2].GetUrl()); st != 404 {
		t.Fatalf("outsider download: %d", st)
	}

	// Emoji, cover, order, delete of an unused sticker.
	a["mgr"].must(200, "PATCH", "/api/stickers/"+got[1].GetId(), &v1.UpdateStickerRequest{Emoji: "🔷"}, nil)
	a["mgr"].must(422, "PATCH", "/api/stickers/"+got[1].GetId(), &v1.UpdateStickerRequest{Emoji: "x"}, nil)
	cover := got[2].GetId()
	var pr v1.StickerPackResponse
	a["mgr"].must(200, "PATCH", "/api/sticker-packs/"+p.GetId(), &v1.UpdateStickerPackRequest{
		CoverStickerId: &cover, StickerIds: []string{got[2].GetId(), got[0].GetId(), got[1].GetId()}}, &pr)
	if pr.GetPack().GetCoverStickerId() != cover || pr.GetPack().GetStickers()[0].GetId() != cover || pr.GetPack().GetStickers()[2].GetEmoji() != "🔷" {
		t.Fatalf("pack after update: %v", pr.GetPack())
	}
	a["mgr"].must(422, "PATCH", "/api/sticker-packs/"+p.GetId(), &v1.UpdateStickerPackRequest{StickerIds: []string{got[0].GetId()}}, nil)
	a["mgr"].must(200, "DELETE", "/api/stickers/"+got[1].GetId(), nil, &pr)
	if len(pr.GetPack().GetStickers()) != 2 {
		t.Fatalf("after delete: %v", pr.GetPack())
	}

	// Orphan cleanup keeps live sticker files and removes the deleted one's.
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE files SET created_at = now() - interval '25 hours' WHERE workspace_id = $1", ws.GetId()); err != nil {
		t.Fatal(err)
	}
	if _, err := testApp.Files.CleanupOrphans(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st, _ := get(a["member"], got[0].GetUrl()); st != 200 {
		t.Fatalf("live sticker after cleanup: %d", st)
	}
	if st, _ := get(o, got[1].GetUrl()); st != 404 {
		t.Fatalf("deleted sticker file after cleanup: %d", st)
	}
}

// TestStickerMessages: a sticker message in a room of the pack's workspace (not by guests),
// in a DM of two members, not elsewhere; no text with it; no edits; a deleted sticker stays
// visible in the history; the DM list preview carries its emoji.
func TestStickerMessages(t *testing.T) {
	ws, room, a := stickerTeam(t)
	o, mem := a["owner"], a["member"]
	p := createPack(t, o, ws.GetId(), "Faces")
	_, up, _ := uploadStickers(t, o, p.GetId(), stickerFile{"😀", "s.webp", stickerFixture(t, "sun.webp")}, stickerFile{"🌀", "o.webp", stickerFixture(t, "orbit.webp")})
	s0, s1 := up.GetAdded()[0], up.GetAdded()[1]

	var cr v1.CreateMessageResponse
	mem.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: s0.GetId(), Nonce: uniq("n")}, &cr)
	if cr.GetMessage().GetSticker().GetId() != s0.GetId() || cr.GetMessage().GetContent() != "" || cr.GetMessage().GetSticker().GetUrl() == "" {
		t.Fatalf("sticker message: %v", cr.GetMessage())
	}
	mid := cr.GetMessage().GetId()
	mem.must(422, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: s0.GetId(), Content: "hi"}, nil)
	mem.must(422, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: "nope"}, nil)
	a["guest"].must(403, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: s0.GetId()}, nil)
	edited := "text"
	mem.must(403, "PATCH", "/api/messages/"+mid, &v1.UpdateMessageRequest{Content: edited}, nil)

	// Another workspace: its rooms cannot use this pack.
	o2 := owner(t)
	ws2 := createWorkspace(t, o2, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	var cr2 v1.CreateRoomResponse
	o2.must(201, "POST", "/api/workspaces/"+ws2.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "t"}, &cr2)
	o2.must(403, "POST", "/api/rooms/"+cr2.GetRoom().GetId()+"/messages", &v1.CreateMessageRequest{StickerId: s0.GetId()}, nil)

	// DM: both are non-guest members → ok; a DM with someone outside the workspace → 403.
	dm := openDM(t, mem, o.id, 201)
	mem.must(201, "POST", "/api/rooms/"+dm.GetRoom().GetId()+"/messages", &v1.CreateMessageRequest{StickerId: s1.GetId()}, nil)
	var dms v1.ListDmsResponse
	o.must(200, "GET", "/api/dms", nil, &dms)
	found := false
	for _, d := range dms.GetDms() {
		if d.GetRoom().GetId() == dm.GetRoom().GetId() {
			found = d.GetLastMessage().GetStickerEmoji() == "🌀"
		}
	}
	if !found {
		t.Fatalf("DM preview without the sticker emoji: %v", dms.GetDms())
	}
	// A DM whose peer is only a guest of the workspace cannot use its packs.
	peer := register(t, invite(t, o, ws.GetId()))
	dm2 := openDM(t, mem, peer.id, 201)
	guestRole := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+peer.id, &v1.UpdateMemberRequest{Role: &guestRole}, nil)
	mem.must(403, "POST", "/api/rooms/"+dm2.GetRoom().GetId()+"/messages", &v1.CreateMessageRequest{StickerId: s1.GetId()}, nil)

	// Deleting a sticker that a message shows keeps it in the history (deleted = true).
	var pr v1.StickerPackResponse
	o.must(200, "DELETE", "/api/stickers/"+s0.GetId(), nil, &pr)
	if len(pr.GetPack().GetStickers()) != 1 {
		t.Fatalf("pack after delete: %v", pr.GetPack())
	}
	var page v1.ListMessagesResponse
	mem.must(200, "GET", "/api/rooms/"+room+"/messages?limit=5", nil, &page)
	if s := page.GetMessages()[0].GetSticker(); s.GetId() != s0.GetId() || !s.GetDeleted() {
		t.Fatalf("history after delete: %v", page.GetMessages()[0])
	}
	mem.must(422, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: s0.GetId()}, nil)
}

// TestStickerPlanLimits: the plan's sticker_packs / stickers → 409 CONFLICT, reason
// PLAN_LIMIT, used / limit; 120 per pack regardless of the plan.
func TestStickerPlanLimits(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	admin := superadminUser(t)
	admin.must(200, "PUT", "/api/admin/workspaces/"+ws.GetId()+"/plan", &v1.AdminSetPlanRequest{Plan: v1.Plan_PLAN_CUSTOM,
		Limits: &v1.PlanLimits{StickerPacks: 1, Stickers: 2}}, nil)
	p := createPack(t, o, ws.GetId(), "One")
	st := o.do("POST", "/api/workspaces/"+ws.GetId()+"/sticker-packs", &v1.CreateStickerPackRequest{Name: "Two"}, nil)
	if e := apiErrBody(t, o.lastBody); st != 409 || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != 1 || e.GetLimit() != 1 {
		t.Fatalf("second pack: %d %v", st, e)
	}
	sun := stickerFixture(t, "sun.webp")
	f := stickerFile{"☀️", "s.webp", sun}
	if st, _, e := uploadStickers(t, o, p.GetId(), f, f, f); st != 409 || e.GetReason() != "PLAN_LIMIT" || e.GetUsed() != 0 || e.GetLimit() != 2 {
		t.Fatalf("over the sticker limit: %d %v", st, e)
	}
	if st, _, e := uploadStickers(t, o, p.GetId(), f, f); st != 201 {
		t.Fatalf("within the limit: %d %v", st, e)
	}
	var gw v1.GetWorkspaceResponse
	o.must(200, "GET", "/api/workspaces/"+ws.GetId(), nil, &gw)
	if l := gw.GetWorkspace().GetPlan().GetLimits(); l.GetStickerPacks() != 1 || l.GetStickers() != 2 {
		t.Fatalf("plan limits: %v", l)
	}
}

func apiErrBody(t *testing.T, raw []byte) *v1.ApiError {
	t.Helper()
	var e v1.ApiError
	_ = protojson.Unmarshal(raw, &e)
	return &e
}

// TestStickerInstallAndEvents: STICKER_PACK_CREATE / UPDATE / DELETE reach every member; a
// member installs packs (first in the order), reorders and removes them; guests cannot
// install; a deleted pack is uninstalled for everyone.
func TestStickerInstallAndEvents(t *testing.T) {
	ws, _, a := stickerTeam(t)
	o, mem := a["owner"], a["member"]
	g := dialGW(t)
	g.identify(mem.token)

	p1 := createPack(t, o, ws.GetId(), "First")
	g.wait("STICKER_PACK_CREATE", func(ev *v1.DispatchEvent) bool {
		return ev.GetStickerPackCreate().GetPack().GetId() == p1.GetId()
	})
	if st, _, e := uploadStickers(t, o, p1.GetId(), stickerFile{"☀️", "s.webp", stickerFixture(t, "sun.webp")}); st != 201 {
		t.Fatalf("upload: %d %v", st, e)
	}
	g.wait("STICKER_PACK_UPDATE", func(ev *v1.DispatchEvent) bool {
		return len(ev.GetStickerPackUpdate().GetPack().GetStickers()) == 1
	})
	p2 := createPack(t, o, ws.GetId(), "Second")

	var mine v1.MyStickerPacksResponse
	mem.must(200, "GET", "/api/me/sticker-packs", nil, &mine)
	if len(mine.GetInstalled()) != 0 || len(mine.GetAvailable()) != 2 {
		t.Fatalf("before install: %v", &mine)
	}
	mem.must(200, "PUT", "/api/me/sticker-packs/"+p1.GetId(), nil, nil)
	mem.must(200, "PUT", "/api/me/sticker-packs/"+p2.GetId(), nil, &mine)
	if len(mine.GetInstalled()) != 2 || mine.GetInstalled()[0].GetId() != p2.GetId() || len(mine.GetAvailable()) != 0 {
		t.Fatalf("installed: %v", &mine)
	}
	mem.must(200, "PUT", "/api/me/sticker-packs/order", &v1.SetStickerPackOrderRequest{PackIds: []string{p1.GetId(), p2.GetId()}}, &mine)
	if mine.GetInstalled()[0].GetId() != p1.GetId() || len(mine.GetInstalled()[0].GetStickers()) != 1 {
		t.Fatalf("order: %v", &mine)
	}
	mem.must(422, "PUT", "/api/me/sticker-packs/order", &v1.SetStickerPackOrderRequest{PackIds: []string{p1.GetId()}}, nil)
	a["guest"].must(404, "PUT", "/api/me/sticker-packs/"+p1.GetId(), nil, nil)
	outsider(t).must(404, "PUT", "/api/me/sticker-packs/"+p1.GetId(), nil, nil)

	o.must(204, "DELETE", "/api/sticker-packs/"+p2.GetId(), nil, nil)
	g.wait("STICKER_PACK_DELETE", func(ev *v1.DispatchEvent) bool {
		return ev.GetStickerPackDelete().GetPackId() == p2.GetId()
	})
	mem.must(200, "GET", "/api/me/sticker-packs", nil, &mine)
	if len(mine.GetInstalled()) != 1 || mine.GetInstalled()[0].GetId() != p1.GetId() {
		t.Fatalf("after pack delete: %v", &mine)
	}
	mem.must(200, "DELETE", "/api/me/sticker-packs/"+p1.GetId(), nil, &mine)
	if len(mine.GetInstalled()) != 0 || len(mine.GetAvailable()) != 1 {
		t.Fatalf("after uninstall: %v", &mine)
	}
}
