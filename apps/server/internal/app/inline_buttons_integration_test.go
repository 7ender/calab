//go:build integration

package app_test

import (
	"context"
	"github.com/calaba/calaba/server/internal/bots"
	"github.com/calaba/calaba/server/internal/perm"
	"google.golang.org/protobuf/encoding/protojson"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"google.golang.org/protobuf/types/known/structpb"
)

func TestInlineKeyboardRoundTrip(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline")
	body, err := structpb.NewStruct(map[string]any{
		"content": "Review this draft", "inlineKeyboard": map[string]any{
			"rows": []any{map[string]any{"buttons": []any{map[string]any{"id": "confirm", "label": "Confirm", "data": "draft:v1"}}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var got structpb.Struct
	b.must(201, "POST", "/api/rooms/"+room.GetId()+"/messages", body, &got)
	if got.AsMap()["message"].(map[string]any)["inlineKeyboard"] == nil {
		t.Fatal("bot keyboard missing from saved message")
	}
	o.must(403, "POST", "/api/rooms/"+room.GetId()+"/messages", body, nil)
	b.must(201, "POST", "/api/rooms/"+room.GetId()+"/messages", &v1.CreateMessageRequest{Content: "ordinary"}, nil)
}

func inlineKeyboard(allowed ...string) *v1.InlineKeyboard {
	return &v1.InlineKeyboard{AllowedUserIds: allowed, Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{
		{Id: "confirm", Label: "Confirm", Data: "draft:v1"}, {Id: "disabled", Label: "Unavailable", Disabled: true},
	}}}}
}

func inlineMessage(t *testing.T, b *bot, room string, k *v1.InlineKeyboard) *v1.Message {
	t.Helper()
	var got v1.CreateMessageResponse
	b.must(201, "POST", "/api/rooms/"+room+"/messages", &v1.CreateMessageRequest{Content: "Review this draft", InlineKeyboard: k}, &got)
	return got.GetMessage()
}

func interaction(m *v1.Message, nonce string) *v1.CreateMessageInteractionRequest {
	return &v1.CreateMessageInteractionRequest{ButtonId: "confirm", KeyboardRevision: m.GetKeyboardRevision(), Nonce: m.GetId() + ":" + nonce}
}

func TestInlineCallbackPrivateAndIdempotent(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline_private")
	other := createBot(t, o, ws.GetId(), "inline_other")
	gb, go2, gh := dialGW(t), dialGW(t), dialGW(t)
	gb.identify(b.token)
	go2.identify(other.token)
	gh.identify(bob.token)
	m := inlineMessage(t, b, room.GetId(), inlineKeyboard(bob.id))
	path := "/api/messages/" + m.GetId() + "/interactions"
	req := interaction(m, "same-press")
	var first, again v1.CreateMessageInteractionResponse
	bob.must(200, "POST", path, req, &first)
	got := gb.wait("private callback", func(e *v1.DispatchEvent) bool { return e.GetBotCallback() != nil }).GetBotCallback()
	if got.GetId() != first.GetInteractionId() || got.GetBotUserId() != b.id || got.GetUserId() != bob.id || got.GetData() != "draft:v1" || got.GetMessageId() != m.GetId() || got.GetWorkspaceId() != ws.GetId() {
		t.Fatalf("callback: %v", got)
	}
	bob.must(200, "POST", path, req, &again)
	if first.GetInteractionId() == "" || first.GetInteractionId() != again.GetInteractionId() {
		t.Fatal("retry changed receipt")
	}
	isCallback := func(e *v1.DispatchEvent) bool { return e.GetBotCallback() != nil }
	gb.quiet("private callback", 100*time.Millisecond, isCallback)
	go2.quiet("private callback", 100*time.Millisecond, isCallback)
	gh.quiet("private callback", 100*time.Millisecond, isCallback)
	b.must(403, "POST", path, req, nil)
	o.must(403, "POST", path, interaction(m, "wrong-user"), nil)
	bad := interaction(m, "same-press")
	bad.ButtonId = "disabled"
	bob.must(409, "POST", path, bad, nil)
	bad.Nonce = "disabled-press"
	bob.must(409, "POST", path, bad, nil)
	bad.ButtonId = "foreign"
	bob.must(409, "POST", path, bad, nil)
	cpActive := forwardMsg(t, o, room.GetId(), m.GetId(), room.GetId(), 201)
	if cpActive.GetInlineKeyboard() != nil || cpActive.GetKeyboardRevision() != 0 {
		t.Fatal("forward retained active keyboard")
	}
	o.must(422, "PATCH", "/api/messages/"+cpActive.GetId(), &v1.UpdateMessageRequest{Content: "forged", InlineKeyboard: inlineKeyboard()}, nil)
	b.must(422, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: "contradiction", PreserveContent: true, InlineKeyboard: inlineKeyboard()}, nil)
	b.must(422, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{PreserveContent: true}, nil)
	var upd v1.UpdateMessageResponse
	b.must(200, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: "Revised draft"}, &upd)
	if upd.GetMessage().GetInlineKeyboard() == nil || upd.GetMessage().GetKeyboardRevision() <= m.GetKeyboardRevision() {
		t.Fatal("text edit did not preserve/version keyboard")
	}
	bob.must(409, "POST", path, interaction(m, "stale-press"), nil)
	b.must(200, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{InlineKeyboard: &v1.InlineKeyboard{}, PreserveContent: true}, &upd)
	if upd.GetMessage().GetContent() != "Revised draft" || upd.GetMessage().GetInlineKeyboard() != nil {
		t.Fatal("keyboard-only removal changed text")
	}
	bob.must(200, "POST", path, req, &again) // already accepted, even after removal
	bob.must(409, "POST", path, interaction(upd.GetMessage(), "removed-press"), nil)
	b.must(422, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: ""}, nil)
	b.must(422, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{}, nil) // legacy empty edit
	cp := forwardMsg(t, o, room.GetId(), m.GetId(), room.GetId(), 201)
	if cp.GetInlineKeyboard() != nil || cp.GetKeyboardRevision() != 0 {
		t.Fatal("forward retained live buttons")
	}
	o.must(204, "DELETE", "/api/messages/"+m.GetId(), nil, nil)
	bob.must(404, "POST", path, req, nil)
}

func TestInlineCallbackAccess(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline_access")
	m := inlineMessage(t, b, room.GetId(), inlineKeyboard())
	path := "/api/messages/" + m.GetId() + "/interactions"
	for _, denied := range []perm.Bits{perm.SendMessages, perm.ViewRoom} {
		o.must(200, "PUT", "/api/rooms/"+room.GetId()+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(bob.id, 0, denied)}}, nil)
		want := 403
		if denied == perm.ViewRoom {
			want = 404
		}
		bob.must(want, "POST", path, interaction(m, "access"), nil)
	}
	o.must(200, "PUT", "/api/rooms/"+room.GetId()+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{userOv(b.id, 0, perm.ViewRoom)}}, nil)
	bob.must(403, "POST", path, interaction(m, "access"), nil)
	o.must(200, "PUT", "/api/rooms/"+room.GetId()+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	bob.must(204, "POST", "/api/me/blocked-bots/"+b.id, nil, nil)
	bob.must(403, "POST", path, interaction(m, "access"), nil)
	bob.must(204, "DELETE", "/api/me/blocked-bots/"+b.id, nil, nil)
	bob.must(200, "POST", path, interaction(m, "access"), nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/bots/"+b.id, nil, nil)
	bob.must(403, "POST", path, interaction(m, "access"), nil) // replay still checks live access
}

func TestInlineCallbackDMAndRevocation(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline_dm")
	rid := openDM(t, o, b.id, 201).GetRoom().GetId()
	m := inlineMessage(t, b, rid, inlineKeyboard())
	path := "/api/messages/" + m.GetId() + "/interactions"
	bob.must(404, "POST", path, interaction(m, "outsider"), nil)
	o.must(200, "POST", path, interaction(m, "accepted"), nil)
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)
	o.must(404, "POST", path, interaction(m, "accepted"), nil)
	fresh := inlineMessage(t, b, rid, inlineKeyboard())
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/bots/"+b.id+"/token", nil, nil)
	o.must(403, "POST", "/api/messages/"+fresh.GetId()+"/interactions", interaction(fresh, "revoked"), nil)
}

func TestInlineCallbackConcurrentAndWebhook(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline_webhook")
	received := make(chan *v1.BotWebhookUpdate, 16)
	secret := strings.Repeat("s", 32)
	hook := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Calab-Signature") != bots.Sign([]byte(secret), body) {
			w.WriteHeader(401)
			return
		}
		var update v1.BotWebhookUpdate
		if err := protojson.Unmarshal(body, &update); err != nil {
			w.WriteHeader(400)
			return
		}
		received <- &update
	}))
	defer hook.Close()
	botHookCAs.AddCert(hook.Certificate())
	b.must(200, "PUT", "/api/bots/me/webhook", &v1.SetBotWebhookRequest{Url: hook.URL, Secret: secret}, nil)
	m := inlineMessage(t, b, room.GetId(), inlineKeyboard())
	path := "/api/messages/" + m.GetId() + "/interactions"
	req := interaction(m, "concurrent")
	ids := make(chan string, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			c := &client{t: t, token: bob.token}
			var got v1.CreateMessageInteractionResponse
			c.must(200, "POST", path, req, &got)
			ids <- got.GetInteractionId()
		})
	}
	wg.Wait()
	close(ids)
	var id string
	for got := range ids {
		if id != "" && id != got {
			t.Fatal("concurrent retries generated different ids")
		}
		id = got
	}
	select {
	case got := <-received:
		if got.GetId() != id || got.GetEvent().GetBotCallback().GetId() != id || got.GetBotUserId() != b.id {
			t.Fatalf("webhook: %v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("callback webhook missing")
	}
	var count int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM bot_webhook_deliveries WHERE id=$1", id).Scan(&count); err != nil || count != 1 {
		t.Fatalf("one outbox receipt: %d %v", count, err)
	}
	// The outbox is part of the receipt transaction: queue failure must not accept the click.
	_, err := testDB.Pool.Exec(context.Background(), "ALTER TABLE bot_webhook_deliveries ADD CONSTRAINT inline_test_fail CHECK (bot_user_id <> '"+b.id+"') NOT VALID")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = testDB.Pool.Exec(context.Background(), "ALTER TABLE bot_webhook_deliveries DROP CONSTRAINT inline_test_fail")
	}()
	bob.must(500, "POST", path, interaction(m, "rollback"), nil)
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM message_interactions WHERE user_id=$1 AND nonce=$2", bob.id, interaction(m, "rollback").GetNonce()).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed queue accepted receipt: %d %v", count, err)
	}
}

func TestInlineCallbackRemovedBotDM(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	home := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	b := createBot(t, o, home.GetId(), "inline_removed")
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/bots/add", &v1.AddBotRequest{BotUserId: b.id}, nil)
	rid := openDM(t, bob, b.id, 201).GetRoom().GetId()
	m := inlineMessage(t, b, rid, inlineKeyboard())
	path := "/api/messages/" + m.GetId() + "/interactions"
	req := interaction(m, "accepted")
	bob.must(200, "POST", path, req, nil)
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/bots/"+b.id, nil, nil)
	b.must(200, "GET", "/api/bots/me", nil, nil) // bot remains live in its separate home
	bob.must(403, "POST", path, req, nil)
	bob.must(403, "POST", path, interaction(m, "removed"), nil)
	var n int
	if err := testDB.Pool.QueryRow(context.Background(), "SELECT count(*) FROM message_interactions WHERE message_id=$1", m.GetId()).Scan(&n); err != nil || n != 1 {
		t.Fatalf("removed bot accepted callback: %d %v", n, err)
	}
}

func TestInlineCallbackTaskRoom(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "inline_task")
	board := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Tasks", Key: "BTN"}, 201)
	task := createTask(t, o, board.GetId(), &v1.CreateTaskRequest{Title: "Review draft"}, 201)
	m := inlineMessage(t, b, task.GetRoomId(), inlineKeyboard(bob.id))
	bob.must(200, "POST", "/api/messages/"+m.GetId()+"/interactions", interaction(m, "task"), nil)
	private := true
	o.must(200, "PATCH", "/api/boards/"+board.GetId(), &v1.UpdateBoardRequest{IsPrivate: &private}, nil)
	bob.must(404, "POST", "/api/messages/"+m.GetId()+"/interactions", interaction(m, "task"), nil)
}
