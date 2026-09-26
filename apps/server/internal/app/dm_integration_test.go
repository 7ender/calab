//go:build integration

package app_test

import (
	"net/url"
	"strings"
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

func openDM(t *testing.T, u *user, peer string, want int) *v1.DmSummary {
	t.Helper()
	var r v1.CreateDmResponse
	u.must(want, "POST", "/api/dms", &v1.CreateDmRequest{UserId: peer}, &r)
	return r.GetDm()
}

func rename(t *testing.T, u *user, name string) {
	t.Helper()
	u.must(200, "PATCH", "/api/me", &v1.UpdateMeRequest{DisplayName: &name}, nil)
}

// TestDirectMessages covers ADR-0020 end to end: get-or-create, access of a third user,
// events on both participants' user channels, READY.dms, files, typing, candidates.
func TestDirectMessages(t *testing.T) {
	o, bob, ws, voice := setupTeam(t)
	wid := ws.GetId()
	tag := uniq("dm")
	rename(t, bob, "Bobby "+tag)
	// carol shares no workspace with o / bob.
	cws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	carol := register(t, invite(t, o, cws.GetId()))
	rename(t, carol, "Carol "+tag)
	roomsBefore := len(visibleRooms(t, bob, wid))

	bg := dialGW(t)
	bg.identify(bob.token)
	og := dialGW(t)
	og.identify(o.token)

	// Validation: self 422, malformed 422, unknown user 404.
	openDM(t, o, o.id, 422)
	openDM(t, o, "nope", 422)
	openDM(t, o, "00000000-0000-7000-8000-000000000000", 404)

	// Create (201) → both participants get DM_CREATE with their own peer.
	dm := openDM(t, o, bob.id, 201)
	rid := dm.GetRoom().GetId()
	if dm.GetRoom().GetType() != v1.RoomType_ROOM_TYPE_DM || dm.GetRoom().GetWorkspaceId() != "" || dm.GetPeer().GetId() != bob.id {
		t.Fatalf("created DM: %v", dm)
	}
	ev := bg.wait("DM_CREATE (bob)", func(e *v1.DispatchEvent) bool { return e.GetDmCreate() != nil })
	if ev.GetDmCreate().GetDm().GetPeer().GetId() != o.id || ev.GetDmCreate().GetDm().GetRoom().GetId() != rid {
		t.Fatalf("bob's DM_CREATE: %v", ev)
	}
	og.wait("DM_CREATE (o)", func(e *v1.DispatchEvent) bool {
		return e.GetDmCreate().GetDm().GetPeer().GetId() == bob.id
	})
	// Idempotent from both sides (200, same room).
	if again := openDM(t, o, bob.id, 200); again.GetRoom().GetId() != rid {
		t.Fatalf("second POST returned another room %s", again.GetRoom().GetId())
	}
	if back := openDM(t, bob, o.id, 200); back.GetRoom().GetId() != rid || back.GetPeer().GetId() != o.id {
		t.Fatalf("POST from the peer: %v", back)
	}
	// No common workspace: 404 (existence of the user is not revealed).
	openDM(t, bob, carol.id, 404)

	// DMs are not rooms of the workspace.
	if n := len(visibleRooms(t, bob, wid)); n != roomsBefore {
		t.Fatalf("workspace rooms changed: %d → %d", roomsBefore, n)
	}
	var gr v1.GetRoomResponse
	bob.must(200, "GET", "/api/rooms/"+rid, nil, &gr)
	if gr.GetRoom().GetType() != v1.RoomType_ROOM_TYPE_DM || perm.Bits(gr.GetPermissions()) != perm.DM {
		t.Fatalf("GET DM room: %v", &gr)
	}

	// Messages: both participants get the events on their user channels.
	m := send(t, o, rid, "привет, Боб", "dm-1")
	for _, g := range []*gw{bg, og} {
		e := g.wait("MESSAGE_CREATE", func(e *v1.DispatchEvent) bool { return e.GetMessageCreate().GetMessage().GetId() == m.GetId() })
		if e.GetMessageCreate().GetWorkspaceId() != "" {
			t.Fatalf("DM message event carries a workspace: %v", e)
		}
	}
	var list v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &list)
	if len(list.GetMessages()) != 1 || list.GetMessages()[0].GetId() != m.GetId() {
		t.Fatalf("bob's history: %v", &list)
	}
	// A third user (even the owner of bob's workspace would be one — here carol) sees nothing.
	carol.must(404, "GET", "/api/rooms/"+rid, nil, nil)
	carol.must(404, "GET", "/api/rooms/"+rid+"/messages", nil, nil)
	carol.must(404, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "hi"}, nil)
	carol.must(404, "PUT", "/api/messages/"+m.GetId()+"/reactions/👍", nil, nil)
	carol.must(404, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: m.GetId()}, nil)
	carol.must(404, "GET", "/api/rooms/"+rid+"/pins", nil, nil)
	carol.must(404, "GET", "/api/rooms/"+rid+"/messages?q=hi", nil, nil)
	carol.must(404, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_NONE}, nil)
	carol.must(404, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)

	// Reactions and pins (both participants may pin; no moderation of the other's messages).
	bob.must(204, "PUT", "/api/messages/"+m.GetId()+"/reactions/👍", nil, nil)
	og.wait("MESSAGE_REACTION_ADD", func(e *v1.DispatchEvent) bool { return e.GetMessageReactionAdd().GetMessageId() == m.GetId() })
	bob.must(204, "PUT", "/api/messages/"+m.GetId()+"/pin", nil, nil)
	og.wait("MESSAGE_UPDATE (pin)", func(e *v1.DispatchEvent) bool {
		return e.GetMessageUpdate().GetMessage().GetId() == m.GetId() && e.GetMessageUpdate().GetMessage().GetPinnedAt() != nil
	})
	bob.must(403, "DELETE", "/api/messages/"+m.GetId(), nil, nil)
	bob.must(403, "PATCH", "/api/messages/"+m.GetId(), &v1.UpdateMessageRequest{Content: "x"}, nil)
	// Rooms / voice / links of a workspace do not apply.
	bob.must(403, "PATCH", "/api/rooms/"+rid, &v1.UpdateRoomRequest{Topic: ptr("x")}, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/join", nil, nil)
	bob.must(403, "POST", "/api/rooms/"+rid+"/invites", &v1.CreateRoomInviteRequest{}, nil)
	o.must(404, "GET", "/api/workspaces/"+wid+"/messages/search?q=hi&room_id="+rid, nil, nil)

	// Notification settings work per DM and come back in READY.
	bob.must(200, "PUT", "/api/rooms/"+rid+"/notifications", &v1.UpdateRoomNotificationSettingsRequest{Level: v1.NotificationLevel_NOTIFICATION_LEVEL_NONE}, nil)

	// READY: dms with the peer and counters (every DM message counts as a mention). The same
	// device re-identifies: bg is replaced by bg2.
	bg2 := dialGW(t)
	ready := bg2.identify(bob.token)
	var got *v1.DmSummary
	for _, d := range ready.GetDms() {
		if d.GetRoom().GetId() == rid {
			got = d
		}
	}
	if got == nil || got.GetPeer().GetId() != o.id || got.GetReadState().GetUnreadCount() != 1 ||
		got.GetReadState().GetMentionCount() != 1 || got.GetLastMessageAt() == nil || got.GetRoom().GetLastMessageId() != m.GetId() {
		t.Fatalf("READY dm: %v", got)
	}
	// The list preview comes with the summary (no history request per DM).
	if lm := got.GetLastMessage(); lm.GetId() != m.GetId() || lm.GetAuthorId() != o.id || lm.GetContent() != "привет, Боб" || lm.GetCreatedAt() == nil {
		t.Fatalf("READY dm last_message: %v", lm)
	}
	inRS := false
	for _, rs := range ready.GetReadStates() {
		inRS = inRS || (rs.GetRoomId() == rid && rs.GetUnreadCount() == 1)
	}
	if !inRS {
		t.Fatal("DM read state missing from READY.read_states")
	}
	muted := false
	for _, n := range ready.GetNotificationSettings() {
		muted = muted || (n.GetRoomId() == rid && n.GetLevel() == v1.NotificationLevel_NOTIFICATION_LEVEL_NONE)
	}
	if !muted {
		t.Fatal("DM notification settings missing from READY")
	}
	// Read → the counter resets; GET /api/dms agrees.
	bob.must(204, "PUT", "/api/rooms/"+rid+"/read", &v1.UpdateReadStateRequest{MessageId: m.GetId()}, nil)
	var dl v1.ListDmsResponse
	bob.must(200, "GET", "/api/dms", nil, &dl)
	if len(dl.GetDms()) != 1 || dl.GetDms()[0].GetReadState().GetUnreadCount() != 0 || dl.GetDms()[0].GetReadState().GetLastReadMessageId() != m.GetId() {
		t.Fatalf("GET /api/dms after read: %v", &dl)
	}

	// Typing: only to the peer's sessions subscribed to the DM.
	bg2.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_SUBSCRIBE, Payload: &v1.GatewayFrame_Subscribe{Subscribe: &v1.Subscribe{RoomIds: []string{rid}}}})
	og.send(&v1.GatewayFrame{Op: v1.GatewayOpcode_GATEWAY_OPCODE_TYPING, Payload: &v1.GatewayFrame_Typing{Typing: &v1.Typing{RoomId: rid}}})
	bg2.wait("TYPING_START", func(e *v1.DispatchEvent) bool {
		return e.GetTypingStart().GetRoomId() == rid && e.GetTypingStart().GetUserId() == o.id
	})
	og.quiet("own TYPING_START", 300*time.Millisecond, func(e *v1.DispatchEvent) bool { return e.GetTypingStart() != nil })

	// Files: uploaded for the DM, readable by both participants only.
	st, f, _ := upload(t, o, "/api/dms/"+rid+"/files", "pic.png", pngBytes(8, 8))
	if st != 201 || f.GetWorkspaceId() != "" {
		t.Fatalf("DM upload: %d %v", st, f)
	}
	if st, _, _ := upload(t, carol, "/api/dms/"+rid+"/files", "x.png", pngBytes(4, 4)); st != 404 {
		t.Fatalf("third user's DM upload: %d", st)
	}
	var cm v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{Content: "", AttachmentIds: []string{f.GetId()}}, &cm)
	if r, _ := get(t, bob, "/api/files/"+f.GetId(), nil); r.StatusCode != 200 {
		t.Fatalf("peer download: %d", r.StatusCode)
	}
	if r, _ := get(t, carol, "/api/files/"+f.GetId(), nil); r.StatusCode != 404 {
		t.Fatalf("third user download: %d", r.StatusCode)
	}
	// Preview of an attachment-only message; a long text is cut to 200 characters.
	var dl2 v1.ListDmsResponse
	bob.must(200, "GET", "/api/dms", nil, &dl2)
	if lm := dl2.GetDms()[0].GetLastMessage(); lm.GetId() != cm.GetMessage().GetId() || lm.GetContent() != "" || lm.GetAttachmentCount() != 1 {
		t.Fatalf("attachment-only last_message: %v", lm)
	}
	long := send(t, bob, rid, strings.Repeat("я", 250), "dm-long")
	bob.must(200, "GET", "/api/dms", nil, &dl2)
	if lm := dl2.GetDms()[0].GetLastMessage(); lm.GetId() != long.GetId() || lm.GetContent() != strings.Repeat("я", 200) || lm.GetAuthorId() != bob.id {
		t.Fatalf("long last_message: %v", lm)
	}
	// A workspace upload cannot be attached in a DM, a DM upload not in a workspace room.
	_, wf, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "w.png", pngBytes(4, 4))
	o.must(422, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{wf.GetId()}}, nil)
	_, df, _ := upload(t, o, "/api/dms/"+rid+"/files", "d.png", pngBytes(4, 4))
	o.must(422, "POST", "/api/rooms/"+voice.GetId()+"/messages", &v1.CreateMessageRequest{AttachmentIds: []string{df.GetId()}}, nil)
	// Avatars stay public.
	_, _, me := upload(t, carol, "/api/me/avatar", "a.png", pngBytes(8, 8))
	if r, _ := get(t, bob, "/api/files/"+me.GetUser().GetAvatarFileId(), nil); r.StatusCode != 200 {
		t.Fatalf("avatar download by a stranger: %d", r.StatusCode)
	}

	// Candidates: users of common workspaces, matched by name; never self or strangers.
	var cands v1.ListDmCandidatesResponse
	o.must(200, "GET", "/api/dms/candidates?q="+url.QueryEscape(strings.ToUpper("bobby "+tag)), nil, &cands)
	if len(cands.GetUsers()) != 1 || cands.GetUsers()[0].GetId() != bob.id {
		t.Fatalf("candidates for bob's name: %v", &cands)
	}
	bob.must(200, "GET", "/api/dms/candidates?q="+"carol%20"+tag, nil, &cands)
	if len(cands.GetUsers()) != 0 {
		t.Fatalf("bob sees carol (no common workspace): %v", &cands)
	}
	bob.must(200, "GET", "/api/dms/candidates", nil, &cands)
	for _, u := range cands.GetUsers() {
		if u.GetId() == bob.id || u.GetId() == carol.id {
			t.Fatalf("candidates contain self or a stranger: %v", &cands)
		}
	}
	bob.must(422, "GET", "/api/dms/candidates?q="+strings.Repeat("x", 65), nil, nil)
}

// TestDirectMessageGuests: guest accounts (ADR-0016) have no DMs, either side.
func TestDirectMessageGuests(t *testing.T) {
	o, _, _, room := setupTeam(t)
	var link v1.CreateRoomInviteResponse
	o.must(201, "POST", "/api/rooms/"+room.GetId()+"/invites", &v1.CreateRoomInviteRequest{}, &link)
	anon := &client{t: t, ip: "10.64.0.1"}
	var gj v1.JoinRoomInviteResponse
	anon.must(201, "POST", "/api/room-invites/"+link.GetInvite().GetCode()+"/join", &v1.JoinRoomInviteRequest{Nickname: "Гость"}, &gj)
	guest := &user{client: &client{t: t, token: gj.GetTokens().GetAccessToken(), ip: "10.64.0.2"}, id: gj.GetMe().GetUser().GetId()}

	openDM(t, guest, o.id, 403)
	guest.must(403, "GET", "/api/dms", nil, nil)
	guest.must(403, "GET", "/api/dms/candidates", nil, nil)
	openDM(t, o, guest.id, 403)
	var cands v1.ListDmCandidatesResponse
	o.must(200, "GET", "/api/dms/candidates?q="+url.QueryEscape("Гость"), nil, &cands)
	for _, u := range cands.GetUsers() {
		if u.GetId() == guest.id {
			t.Fatal("guest account offered as a DM candidate")
		}
	}
	if ready := dialGW(t).identify(guest.token); len(ready.GetDms()) != 0 {
		t.Fatalf("guest READY has DMs: %v", ready.GetDms())
	}
}

// TestDirectMessageRateLimit: at most 10 new DMs at once (30 per hour) per user; opening an
// existing DM is not limited.
func TestDirectMessageRateLimit(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	alice := register(t, invite(t, o, ws.GetId()))
	var peers []*user
	code := ""
	for i := range 11 {
		if i%9 == 0 { // an invite takes 10 uses
			code = invite(t, o, ws.GetId())
		}
		peers = append(peers, register(t, code))
	}
	for i, p := range peers[:10] {
		if st := alice.do("POST", "/api/dms", &v1.CreateDmRequest{UserId: p.id}, nil); st != 201 {
			t.Fatalf("DM %d: %d", i, st)
		}
	}
	if st := alice.do("POST", "/api/dms", &v1.CreateDmRequest{UserId: peers[10].id}, nil); st != 429 {
		t.Fatalf("11th new DM: %d, want 429", st)
	}
	openDM(t, alice, peers[0].id, 200)
	openDM(t, peers[10], alice.id, 201) // the limit is per creator
}

func ptr[T any](v T) *T { return &v }
