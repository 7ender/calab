//go:build integration

package app_test

import (
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestMentions(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	mentions := func(u *user, query string) *v1.ListMessagesResponse {
		var out v1.ListMessagesResponse
		u.must(200, "GET", "/api/me/mentions"+query, nil, &out)
		return &out
	}
	direct := send(t, o, rid, "hi @"+bob.id+", see this", "")
	everyone := send(t, o, rid, "@everyone lunch", "")
	send(t, bob, rid, "code: `@"+o.id+"` and mail@"+o.id, "") // not mentions
	send(t, bob, rid, "@"+bob.id+" note to self", "")         // own mention: not stored

	// A private room bob cannot see: its mentions stay hidden from him.
	var pr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "private", IsPrivate: true}, &pr)
	send(t, o, pr.GetRoom().GetId(), "secret @"+bob.id, "")

	got := mentions(bob, "")
	if len(got.GetMessages()) != 2 || got.GetMessages()[0].GetId() != everyone.GetId() || got.GetMessages()[1].GetId() != direct.GetId() {
		t.Fatalf("bob mentions: %v", got.GetMessages())
	}
	if n := len(mentions(o, "").GetMessages()); n != 0 {
		t.Fatalf("owner has %d mentions (own @everyone and code spans must not count)", n)
	}
	page := mentions(bob, "?limit=1")
	if len(page.GetMessages()) != 1 || !page.GetHasMore() {
		t.Fatal("pagination: first page")
	}
	page = mentions(bob, "?limit=1&before="+page.GetMessages()[0].GetId())
	if len(page.GetMessages()) != 1 || page.GetHasMore() || page.GetMessages()[0].GetId() != direct.GetId() {
		t.Fatal("pagination: second page")
	}
	if n := len(mentions(bob, "?workspace_id="+ws.GetId()).GetMessages()); n != 2 {
		t.Fatalf("workspace filter: %d", n)
	}
	// Editing the mention away and deleting the @everyone message remove them from history.
	o.must(200, "PATCH", "/api/messages/"+direct.GetId(), &v1.UpdateMessageRequest{Content: "hi all"}, nil)
	o.must(204, "DELETE", "/api/messages/"+everyone.GetId(), nil, nil)
	if n := len(mentions(bob, "").GetMessages()); n != 0 {
		t.Fatalf("after edit/delete: %d mentions", n)
	}
	o.must(200, "PATCH", "/api/messages/"+direct.GetId(), &v1.UpdateMessageRequest{Content: "again @" + bob.id}, nil)
	if n := len(mentions(bob, "").GetMessages()); n != 1 {
		t.Fatalf("mention added by edit: %d", n)
	}
	bob.must(400, "GET", "/api/me/mentions?after="+direct.GetId(), nil, nil)
}

func TestRoomNotificationSettings(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	g := dialGW(t)
	if n := len(g.identify(bob.token).GetNotificationSettings()); n != 0 {
		t.Fatalf("READY has %d settings by default", n)
	}
	until := time.Now().Add(time.Hour).Truncate(time.Second)
	var resp v1.UpdateRoomNotificationSettingsResponse
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{
		Level: v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS, MutedUntil: timestamppb.New(until),
	}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS || !resp.GetSettings().GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("response: %v", resp.GetSettings())
	}
	g.wait("ROOM_NOTIFICATION_UPDATE", func(e *v1.DispatchEvent) bool {
		s := e.GetRoomNotificationUpdate().GetSettings()
		return s.GetRoomId() == rid && s.GetLevel() == v1.NotificationLevel_NOTIFICATION_LEVEL_MENTIONS
	})
	ns := dialGW(t).identify(bob.token).GetNotificationSettings()
	if len(ns) != 1 || ns[0].GetRoomId() != rid || !ns[0].GetMutedUntil().AsTime().Equal(until) {
		t.Fatalf("READY settings: %v", ns)
	}
	if n := len(dialGW(t).identify(o.token).GetNotificationSettings()); n != 0 {
		t.Fatal("settings leaked to another user")
	}
	// Validation and access.
	bob.must(422, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{
		MutedUntil: timestamppb.New(time.Now().Add(2 * 365 * 24 * time.Hour)),
	}, nil)
	bob.must(422, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: 42}, nil)
	var pr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "private", IsPrivate: true}, &pr)
	bob.must(404, "PUT", "/api/rooms/"+pr.GetRoom().GetId()+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{}, nil)
	// Back to the default: the row is gone.
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_ALL}, &resp)
	if resp.GetSettings().GetLevel() != v1.NotificationLevel_NOTIFICATION_LEVEL_ALL || resp.GetSettings().GetMutedUntil() != nil {
		t.Fatalf("reset response: %v", resp.GetSettings())
	}
	if n := len(dialGW(t).identify(bob.token).GetNotificationSettings()); n != 0 {
		t.Fatal("default settings still stored")
	}
}
