//go:build integration

package app_test

import (
	"context"
	"io"
	"net/http"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/builtinstickers"
	"github.com/calaba/calaba/server/internal/perm"
)

func TestBuiltinStickers(t *testing.T) {
	ws, room, actors := stickerTeam(t)
	o, mem, guest := actors["owner"], actors["member"], actors["guest"]
	p := builtinstickers.Pack()
	sid := p.Stickers[0].Id
	for _, u := range []*user{o, mem, guest, outsider(t)} {
		var mine v1.MyStickerPacksResponse
		u.must(200, "GET", "/api/me/sticker-packs", nil, &mine)
		// The shared owner (owner(t)) may have packs installed by earlier tests of the shard:
		// it must have exactly one built-in pack; fresh users have nothing else.
		var builtins []*v1.StickerPack
		for _, pk := range mine.Installed {
			if pk.Builtin {
				builtins = append(builtins, pk)
			}
		}
		if len(builtins) != 1 || builtins[0].Id != p.Id || len(builtins[0].Stickers) != 16 || (u != o && len(mine.Installed) != 1) {
			t.Fatalf("default pack: %v", &mine)
		}
		u.must(200, "GET", "/api/sticker-packs/"+p.Id, nil, nil)
		u.must(403, "PATCH", "/api/sticker-packs/"+p.Id, &v1.UpdateStickerPackRequest{}, nil)
		u.must(403, "DELETE", "/api/sticker-packs/"+p.Id, nil, nil)
		u.must(403, "PUT", "/api/me/sticker-packs/"+p.Id, nil, nil)
		u.must(403, "DELETE", "/api/me/sticker-packs/"+p.Id, nil, nil)
		u.must(403, "PATCH", "/api/stickers/"+sid, &v1.UpdateStickerRequest{Emoji: "🙂"}, nil)
		u.must(403, "DELETE", "/api/stickers/"+sid, nil, nil)
		if st, _, _ := uploadStickers(t, u, p.Id, stickerFile{"😀", "s.webp", stickerFixture(t, "sun.webp")}); st != 403 {
			t.Fatalf("builtin upload: %d", st)
		}
		if st, _, _ := replaceSticker(t, u, p.Id, sid, "😀", stickerFixture(t, "sun.webp")); st != 403 {
			t.Fatalf("builtin replace: %d", st)
		}
	}
	// Public artwork endpoint exposes only allowlisted assets without authentication.
	req, _ := http.NewRequestWithContext(context.Background(), "GET", srv.URL+p.Stickers[0].Url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil || resp.StatusCode != 200 || len(data) != int(p.Stickers[0].Size) {
		t.Fatalf("public asset: %d %v", resp.StatusCode, err)
	}
	// Free workspace has no pack usage until it creates its own pack.
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM sticker_packs WHERE workspace_id=$1", ws.Id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("quota: %d %v", n, err)
	}
	createPack(t, o, ws.Id, "Custom")
	// The order must list every installed custom pack; the shared owner may have more from
	// earlier tests of the shard.
	var installed v1.MyStickerPacksResponse
	o.must(200, "GET", "/api/me/sticker-packs", nil, &installed)
	var own []string
	for _, pk := range installed.Installed {
		if !pk.Builtin {
			own = append(own, pk.Id)
		}
	}
	o.must(200, "PUT", "/api/me/sticker-packs/order", &v1.SetStickerPackOrderRequest{PackIds: own}, nil)
	// A pre-ADR-0057 client lists the built-in pack too: it is skipped, not a 422.
	o.must(200, "PUT", "/api/me/sticker-packs/order", &v1.SetStickerPackOrderRequest{PackIds: append([]string{p.Id}, own...)}, nil)
	o.must(422, "PUT", "/api/me/sticker-packs/order", &v1.SetStickerPackOrderRequest{PackIds: append([]string{p.Id, p.Id}, own...)}, nil)
	// Regular send, nonce replay and history all resolve embedded metadata.
	var sent v1.CreateMessageResponse
	payload := &v1.CreateMessageRequest{StickerId: sid, Nonce: uniq("builtin")}
	mem.must(201, "POST", "/api/rooms/"+room+"/messages", payload, &sent)
	if sent.GetMessage().GetSticker().GetUrl() != p.Stickers[0].Url {
		t.Fatalf("send: %v", &sent)
	}
	mem.must(200, "POST", "/api/rooms/"+room+"/messages", payload, nil)
	var history v1.ListMessagesResponse
	mem.must(200, "GET", "/api/rooms/"+room+"/messages", nil, &history)
	if len(history.Messages) != 1 || history.Messages[0].GetSticker().GetId() != sid {
		t.Fatalf("history: %v", &history)
	}
	guest.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: sid}, nil)
	guest.must(201, "POST", "/api/rooms/"+room+"/messages/"+sent.Message.Id+"/forward", &v1.ForwardMessageRequest{ToRoomId: room}, nil)
	mem.must(422, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: sid, Content: "text"}, nil)
	// DM of users without a shared workspace is allowed for the global pack.
	other := register(t, invite(t, o, ws.Id))
	dm := openDM(t, mem, other.id, 201).GetRoom().GetId()
	o.must(204, "DELETE", "/api/workspaces/"+ws.Id+"/members/"+other.id, nil, nil)
	mem.must(201, "POST", "/api/rooms/"+dm+"/messages", &v1.CreateMessageRequest{StickerId: sid}, nil)
	var forwarded v1.ForwardMessageResponse
	mem.must(201, "POST", "/api/rooms/"+room+"/messages/"+sent.Message.Id+"/forward", &v1.ForwardMessageRequest{ToRoomId: dm}, &forwarded)
	if forwarded.GetMessage().GetSticker().GetId() != sid {
		t.Fatalf("forward: %v", &forwarded)
	}
	// SEND_MESSAGES remains mandatory, independently of owning the global pack.
	o.must(200, "PUT", "/api/rooms/"+room+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(mem.id, 0, perm.SendMessages)}}, nil)
	mem.must(403, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{StickerId: sid}, nil)
}

func TestBuiltinStickersScopedSession(t *testing.T) {
	f := identitySetup(t, "optional")
	p := builtinstickers.Pack()
	var mine v1.MyStickerPacksResponse
	f.scoped.must(200, "GET", "/api/me/sticker-packs", nil, &mine)
	if len(mine.Installed) == 0 || mine.Installed[0].Id != p.Id {
		t.Fatal("scoped session has no built-in pack")
	}
	f.scoped.must(200, "GET", "/api/sticker-packs/"+p.Id, nil, nil)
	f.scoped.must(201, "POST", "/api/rooms/"+f.roomA+"/messages", &v1.CreateMessageRequest{StickerId: p.Stickers[0].Id}, nil)
	f.scoped.must(403, "POST", "/api/rooms/"+f.roomB+"/messages", &v1.CreateMessageRequest{StickerId: p.Stickers[0].Id}, nil)
	f.scoped.must(403, "DELETE", "/api/sticker-packs/"+p.Id, nil, nil)
}
