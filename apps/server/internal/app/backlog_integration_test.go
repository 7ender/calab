//go:build integration

package app_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestCategories(t *testing.T) {
	o, bob, ws, voiceRoom := setupTeam(t)
	wid := ws.GetId()
	g := dialGW(t)
	g.identify(bob.token)

	var c1, c2 v1.CreateCategoryResponse
	bob.must(403, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "x"}, nil)
	o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "Голос"}, &c1)
	o.must(201, "POST", "/api/workspaces/"+wid+"/categories", &v1.CreateCategoryRequest{Name: "Текст"}, &c2)
	if c1.GetCategory().GetPosition() != 0 || c2.GetCategory().GetPosition() != 1 {
		t.Fatal("categories not appended")
	}
	g.wait("CATEGORY_CREATE", func(e *v1.DispatchEvent) bool {
		return e.GetCategoryCreate().GetCategory().GetId() == c2.GetCategory().GetId()
	})

	var tr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "chat", CategoryId: c2.GetCategory().GetId()}, &tr)
	if tr.GetRoom().GetCategoryId() != c2.GetCategory().GetId() {
		t.Fatal("room created outside its category")
	}
	cat1 := c1.GetCategory().GetId()
	o.must(200, "PATCH", "/api/rooms/"+voiceRoom.GetId(), &v1.UpdateRoomRequest{CategoryId: &cat1}, nil)
	g.wait("ROOM_UPDATE category", func(e *v1.DispatchEvent) bool { return e.GetRoomUpdate().GetRoom().GetCategoryId() == cat1 })

	// Category of another workspace is rejected.
	other := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	var oc v1.CreateCategoryResponse
	o.must(201, "POST", "/api/workspaces/"+other.GetId()+"/categories", &v1.CreateCategoryRequest{Name: "foreign"}, &oc)
	foreign := oc.GetCategory().GetId()
	o.must(422, "PATCH", "/api/rooms/"+voiceRoom.GetId(), &v1.UpdateRoomRequest{CategoryId: &foreign}, nil)

	// Batch reorder: swap categories, move the text room to the voice category first.
	var ord v1.SetRoomOrderResponse
	o.must(200, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{
		Categories: []*v1.SetRoomOrderRequest_CategoryPosition{{CategoryId: cat1, Position: 1}, {CategoryId: c2.GetCategory().GetId(), Position: 0}},
		Rooms:      []*v1.SetRoomOrderRequest_RoomPosition{{RoomId: tr.GetRoom().GetId(), Position: 0, CategoryId: cat1}, {RoomId: voiceRoom.GetId(), Position: 1, CategoryId: cat1}},
	}, &ord)
	if len(ord.GetRooms()) != 2 || len(ord.GetCategories()) != 2 || ord.GetRooms()[0].GetCategoryId() != cat1 {
		t.Fatalf("reorder: %v", &ord)
	}
	bob.must(403, "PUT", "/api/workspaces/"+wid+"/rooms/order", &v1.SetRoomOrderRequest{}, nil)

	// READY carries categories and room placement (owner's device: bob's socket stays open).
	ready := dialGW(t).identify(o.token)
	for _, s := range ready.GetWorkspaces() {
		if s.GetWorkspace().GetId() != wid {
			continue
		}
		if len(s.GetCategories()) != 2 || s.GetCategories()[0].GetId() != c2.GetCategory().GetId() {
			t.Fatalf("READY categories: %v", s.GetCategories())
		}
	}

	// Deleting a category moves its rooms out (ROOM_UPDATE with empty category).
	o.must(204, "DELETE", "/api/categories/"+cat1, nil, nil)
	g.wait("CATEGORY_DELETE", func(e *v1.DispatchEvent) bool { return e.GetCategoryDelete().GetCategoryId() == cat1 })
	g.wait("ROOM_UPDATE out of category", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == voiceRoom.GetId() && r.GetCategoryId() == ""
	})
	var lc v1.ListCategoriesResponse
	bob.must(200, "GET", "/api/workspaces/"+wid+"/categories", nil, &lc)
	if len(lc.GetCategories()) != 1 {
		t.Fatalf("categories left: %d", len(lc.GetCategories()))
	}
}

func TestSearch(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	var priv v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "secret", IsPrivate: true}, &priv)
	m1 := send(t, o, rid, "Кошки бегают по крыше", "")
	send(t, bob, rid, "Запускаем deploy-скрипт на стенде", "")
	send(t, o, rid, "Hello world", "")
	send(t, o, priv.GetRoom().GetId(), "секретные кошки", "")

	search := func(u *user, path string) *v1.ListMessagesResponse {
		t.Helper()
		var r v1.ListMessagesResponse
		u.must(200, "GET", path, nil, &r)
		return &r
	}
	// Russian stemming: "кошка" finds "Кошки".
	if r := search(bob, "/api/rooms/"+rid+"/messages?q="+url.QueryEscape("кошка")); len(r.GetMessages()) != 1 || r.GetMessages()[0].GetId() != m1.GetId() {
		t.Fatalf("stemmed search: %v", r.GetMessages())
	}
	if r := search(bob, "/api/rooms/"+rid+"/messages?q=deploy"); len(r.GetMessages()) != 1 {
		t.Fatalf("simple-config word: %d", len(r.GetMessages()))
	}
	// Workspace search respects VIEW_ROOM: bob does not see the private room's message.
	if r := search(bob, "/api/workspaces/"+ws.GetId()+"/messages/search?q="+url.QueryEscape("кошки")); len(r.GetMessages()) != 1 {
		t.Fatalf("bob sees %d results", len(r.GetMessages()))
	}
	if r := search(o, "/api/workspaces/"+ws.GetId()+"/messages/search?q="+url.QueryEscape("кошки")); len(r.GetMessages()) != 2 {
		t.Fatalf("owner sees %d results", len(r.GetMessages()))
	}
	bob.must(404, "GET", "/api/workspaces/"+ws.GetId()+"/messages/search?q=x&room_id="+priv.GetRoom().GetId(), nil, nil)
	if r := search(o, "/api/workspaces/"+ws.GetId()+"/messages/search?q="+url.QueryEscape("кошки deploy OR hello")+"&author_id="+bob.id); len(r.GetMessages()) != 0 {
		t.Fatalf("author filter: %v", r.GetMessages())
	}
	// Cursor.
	for i := range 3 {
		send(t, o, rid, fmt.Sprintf("ping номер %d", i), "")
	}
	r := search(bob, "/api/rooms/"+rid+"/messages?q=ping&limit=2")
	if len(r.GetMessages()) != 2 || !r.GetHasMore() {
		t.Fatalf("page 1: %d %v", len(r.GetMessages()), r.GetHasMore())
	}
	r = search(bob, "/api/rooms/"+rid+"/messages?q=ping&limit=2&before="+r.GetMessages()[1].GetId())
	if len(r.GetMessages()) != 1 || r.GetHasMore() {
		t.Fatalf("page 2: %d %v", len(r.GetMessages()), r.GetHasMore())
	}
	bob.must(422, "GET", "/api/rooms/"+rid+"/messages?q=", nil, nil)
	bob.must(400, "GET", "/api/rooms/"+rid+"/messages?q=x&limit=51", nil, nil)
}

func TestUnfurl(t *testing.T) {
	o := owner(t)
	var hits atomic.Int32
	png := pngBytes(32, 32)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/article":
			hits.Add(1)
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = fmt.Fprint(w, `<html><head><title>T</title><meta property="og:title" content="Статья">
<meta property="og:description" content="Коротко"><meta property="og:site_name" content="Пример">
<meta property="og:image" content="/cover.png"></head><body></body></html>`)
		case "/cover.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(png)
		case "/fake.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = fmt.Fprint(w, "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
		default:
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = fmt.Fprint(w, "%PDF")
		}
	}))
	defer site.Close()

	get := func(path string) (int, []byte, http.Header) {
		t.Helper()
		req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+o.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b, resp.Header
	}
	st, b, _ := get("/api/unfurl?url=" + url.QueryEscape(site.URL+"/article"))
	var card v1.UnfurlResponse
	_ = protojson.Unmarshal(b, &card)
	if st != 200 || card.GetTitle() != "Статья" || card.GetDescription() != "Коротко" || card.GetSiteName() != "Пример" ||
		!strings.HasPrefix(card.GetImageUrl(), "/api/unfurl/image?") || strings.Contains(card.GetImageUrl(), "127.0.0.1:") && !strings.Contains(card.GetImageUrl(), "sig=") {
		t.Fatalf("card: %d %s", st, b)
	}
	// Cached: the site is not hit again.
	get("/api/unfurl?url=" + url.QueryEscape(site.URL+"/article"))
	if hits.Load() != 1 {
		t.Fatalf("site hit %d times", hits.Load())
	}
	// Image through the proxy; tampering with the URL or signature is rejected.
	st, b, h := get(card.GetImageUrl())
	if st != 200 || h.Get("Content-Type") != "image/png" || len(b) != len(png) || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("proxied image: %d %s %d", st, h.Get("Content-Type"), len(b))
	}
	if st, _, _ := get(strings.Replace(card.GetImageUrl(), "cover", "other", 1)); st != 403 {
		t.Fatalf("tampered url: %d", st)
	}
	// Non-HTML pages give no preview (and are negatively cached); SVG is never proxied.
	if st, _, _ := get("/api/unfurl?url=" + url.QueryEscape(site.URL+"/doc.pdf")); st != 404 {
		t.Fatalf("pdf: %d", st)
	}
	if st, _, _ := get("/api/unfurl?url=" + url.QueryEscape("ftp://example.com/x")); st != 422 {
		t.Fatalf("ftp: %d", st)
	}
	_ = time.Now
}

func TestReactionsPinsStatus(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	m := send(t, o, rid, "react to me", "")
	g := dialGW(t)
	g.identify(o.token)

	thumbs := url.PathEscape("👍")
	bob.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+thumbs, nil, nil)
	bob.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+thumbs, nil, nil) // idempotent
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/"+url.PathEscape("❤️"), nil, nil)
	g.wait("MESSAGE_REACTION_ADD", func(e *v1.DispatchEvent) bool {
		a := e.GetMessageReactionAdd()
		return a.GetUserId() == bob.id && a.GetEmoji() == "👍" && a.GetMessageId() == m.GetId()
	})
	bob.must(422, "PUT", "/api/messages/"+m.GetId()+"/reactions/abc", nil, nil)
	var page v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages?limit=1", nil, &page)
	rs := page.GetMessages()[0].GetReactions()
	if len(rs) != 2 || rs[0].GetEmoji() != "👍" || rs[0].GetCount() != 1 || !rs[0].GetMe() || rs[1].GetMe() {
		t.Fatalf("reactions: %v", rs)
	}
	bob.must(204, "DELETE", "/api/messages/"+m.GetId()+"/reactions/"+thumbs, nil, nil)
	g.wait("MESSAGE_REACTION_REMOVE", func(e *v1.DispatchEvent) bool { return e.GetMessageReactionRemove().GetUserId() == bob.id })

	// Pins: MANAGE_MESSAGES only; MESSAGE_UPDATE keeps reaction counts.
	bob.must(403, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	o.must(204, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	ev := g.wait("MESSAGE_UPDATE pinned", func(e *v1.DispatchEvent) bool { return e.GetMessageUpdate().GetMessage().GetPinnedAt() != nil })
	if msg := ev.GetMessageUpdate().GetMessage(); msg.GetPinnedBy() != o.id || len(msg.GetReactions()) != 1 || msg.GetReactions()[0].GetMe() {
		t.Fatalf("pin event: %v", msg)
	}
	var pins v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/pins", nil, &pins)
	if len(pins.GetMessages()) != 1 || pins.GetMessages()[0].GetId() != m.GetId() {
		t.Fatalf("pins: %v", pins.GetMessages())
	}
	o.must(204, "DELETE", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	bob.must(200, "GET", "/api/rooms/"+rid+"/pins", nil, &pins)
	if len(pins.GetMessages()) != 0 {
		t.Fatal("unpin failed")
	}

	// Custom status → PRESENCE_UPDATE to workspace members.
	var me v1.UpdateMeResponse
	bob.must(200, "PATCH", "/api/me/status", &v1.UpdateStatusRequest{Text: "на встрече", Emoji: "📅", ExpiresInSeconds: 3600}, &me)
	if me.GetMe().GetUser().GetStatusEmoji() != "📅" || me.GetMe().GetUser().GetStatusExpiresAt() == nil {
		t.Fatalf("status: %v", me.GetMe().GetUser())
	}
	g.wait("PRESENCE_UPDATE with status", func(e *v1.DispatchEvent) bool {
		p := e.GetPresenceUpdate().GetPresence()
		return p.GetUserId() == bob.id && p.GetStatusText() == "на встрече" && p.GetStatusEmoji() == "📅"
	})
	bob.must(422, "PATCH", "/api/me/status", &v1.UpdateStatusRequest{Emoji: "not emoji"}, nil)
	if _, err := testDB.Pool.Exec(context.Background(), "UPDATE users SET status_expires_at = now() - interval '1 minute' WHERE id = $1", bob.id); err != nil {
		t.Fatal(err)
	}
	var gm v1.GetMeResponse
	bob.must(200, "GET", "/api/me", nil, &gm)
	if gm.GetMe().GetUser().GetStatusText() != "" {
		t.Fatal("expired status still returned")
	}
	_ = ws
}

func TestVoiceTimes(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	roomName := "ws_" + ws.GetId() + "_room_" + rid
	var bj, oj v1.JoinVoiceResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &bj)
	o.must(200, "POST", "/api/rooms/"+rid+"/join", nil, &oj)
	g := dialGW(t)
	g.identify(o.token)
	webhook(t, whEvent("participant_joined", roomName, bj.GetIdentity(), nil), "secret")
	// Bob's voice state and the call start (ROOM_UPDATE, server time for every client's
	// timer; published under the voice lock, so it may come first) — in any order.
	var joined, callStart time.Time
	g.wait("VOICE_STATE_UPDATE bob + ROOM_UPDATE call started", func(e *v1.DispatchEvent) bool {
		if vs := e.GetVoiceStateUpdate().GetState(); vs.GetUserId() == bob.id {
			joined = vs.GetJoinedAt().AsTime()
		}
		if r := e.GetRoomUpdate().GetRoom(); r.GetId() == rid && r.GetVoiceStartedAt() != nil {
			callStart = r.GetVoiceStartedAt().AsTime()
		}
		return !joined.IsZero() && !callStart.IsZero()
	})
	if time.Since(joined) > time.Minute || time.Since(joined) < 0 || !callStart.Equal(joined) {
		t.Fatalf("joined_at %v, call start %v", joined, callStart)
	}
	time.Sleep(20 * time.Millisecond)
	webhook(t, whEvent("participant_joined", roomName, oj.GetIdentity(), nil), "secret")
	g.wait("VOICE_STATE_UPDATE owner", func(e *v1.DispatchEvent) bool { return e.GetVoiceStateUpdate().GetState().GetUserId() == o.id })
	started := func() *v1.Room {
		for _, s := range dialGW(t).identify(bob.token).GetWorkspaces() {
			for _, r := range s.GetRooms() {
				if r.GetId() == rid {
					return r
				}
			}
		}
		return nil
	}
	if r := started(); r.GetVoiceStartedAt() == nil || !r.GetVoiceStartedAt().AsTime().Equal(joined) {
		t.Fatalf("voice_started_at %v, want %v (first join)", r.GetVoiceStartedAt(), joined)
	}
	// Other ROOM_UPDATEs (a rename) keep the running call's start.
	name := "renamed"
	o.must(200, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Name: &name}, nil)
	g.wait("ROOM_UPDATE rename keeps call start", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetName() == name && r.GetVoiceStartedAt().AsTime().Equal(joined)
	})
	// The first participant leaves: the call continues, start time unchanged.
	webhook(t, whEvent("participant_left", roomName, bj.GetIdentity(), nil), "secret")
	time.Sleep(100 * time.Millisecond)
	if r := started(); r.GetVoiceStartedAt() == nil || !r.GetVoiceStartedAt().AsTime().Equal(joined) {
		t.Fatalf("after first left: %v", r.GetVoiceStartedAt())
	}
	webhook(t, whEvent("participant_left", roomName, oj.GetIdentity(), nil), "secret")
	g.wait("ROOM_UPDATE call ended", func(e *v1.DispatchEvent) bool {
		r := e.GetRoomUpdate().GetRoom()
		return r.GetId() == rid && r.GetVoiceStartedAt() == nil
	})
	if r := started(); r.GetVoiceStartedAt() != nil {
		t.Fatal("empty room still has voice_started_at")
	}
	_ = livekit.TrackSource_MICROPHONE
}
