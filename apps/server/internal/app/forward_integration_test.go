//go:build integration

package app_test

import (
	"crypto/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/proto"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/gptunnel/gptunneltest"
	"github.com/calaba/calaba/server/internal/perm"
)

type musty interface {
	must(want int, method, path string, in, out proto.Message)
}

func forwardMsg(t *testing.T, u musty, roomID, msgID, to string, want int) *v1.Message {
	t.Helper()
	var r v1.ForwardMessageResponse
	u.must(want, "POST", "/api/rooms/"+roomID+"/messages/"+msgID+"/forward", &v1.ForwardMessageRequest{ToRoomId: to}, &r)
	return r.GetMessage()
}

func fileStatus(t *testing.T, u *user, fileID string) int {
	t.Helper()
	r, _ := get(t, u, "/api/files/"+fileID, nil)
	return r.StatusCode
}

// TestForwardMessages (ADR-0033): a copy in a DM and in a room of another workspace carries the
// same files (readable through the copy, not after it is deleted), no mentions, the original's
// author and time; a copy of a copy points at the original; the rights of both rooms apply.
func TestForwardMessages(t *testing.T) {
	o := owner(t)
	ws := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	wid := ws.GetId()
	bob := register(t, invite(t, o, wid))
	roomA := textRoom(t, o, wid, "general", false)
	var cr v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+wid+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_TEXT, Name: "announcements"}, &cr)
	roomB := cr.GetRoom().GetId() // bob may read, not write
	o.must(200, "PUT", "/api/rooms/"+roomB+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: append(slices.Clone(cr.GetRoom().GetPermissionOverrides()),
		userOv(bob.id, 0, perm.SendMessages))}, nil)
	ws2 := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	stranger := register(t, invite(t, o, ws2.GetId())) // not in ws: sees nothing of room A
	roomC := textRoom(t, o, ws2.GetId(), "elsewhere", false)
	dm := openDM(t, o, bob.id, 201).GetRoom().GetId()

	_, f, _ := upload(t, o, "/api/workspaces/"+wid+"/files", "plan.png", pngBytes(8, 8))
	var orig v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+roomA+"/messages", &v1.CreateMessageRequest{
		Content: "План @" + bob.id + " @everyone", AttachmentIds: []string{f.GetId()}, Nonce: uniq("fw"),
	}, &orig)
	src := orig.GetMessage()
	if st := fileStatus(t, stranger, f.GetId()); st != 404 {
		t.Fatalf("stranger reads the file before forwarding: %d", st)
	}

	// Into another workspace's room: the stranger reads the file through the copy.
	sg := dialGW(t)
	sg.identify(stranger.token)
	cp := forwardMsg(t, o, roomA, src.GetId(), roomC, 201)
	fw := cp.GetForward()
	if cp.GetRoomId() != roomC || cp.GetAuthorId() != o.id || cp.GetContent() != src.GetContent() || fw.GetAuthorId() != o.id ||
		fw.GetMessageId() != src.GetId() || fw.GetRoomId() != roomA || !fw.GetSentAt().AsTime().Equal(src.GetCreatedAt().AsTime()) ||
		len(cp.GetAttachments()) != 1 || cp.GetAttachments()[0].GetId() != f.GetId() || cp.GetNonce() != "" {
		t.Fatalf("copy: %v", cp)
	}
	sg.wait("MESSAGE_CREATE of the copy", func(e *v1.DispatchEvent) bool {
		m := e.GetMessageCreate().GetMessage()
		return m.GetId() == cp.GetId() && m.GetForward().GetMessageId() == src.GetId()
	})
	if st := fileStatus(t, stranger, f.GetId()); st != 200 {
		t.Fatalf("stranger reads the file through the copy: %d", st)
	}
	var list v1.ListMessagesResponse
	stranger.must(200, "GET", "/api/rooms/"+roomC+"/messages", nil, &list)
	if len(list.GetMessages()) != 1 || list.GetMessages()[0].GetForward().GetRoomId() != roomA {
		t.Fatalf("history of the target: %v", list.GetMessages())
	}
	// The copy is not the original: it cannot be edited; deleting it revokes the file.
	o.must(422, "PATCH", "/api/messages/"+cp.GetId(), &v1.UpdateMessageRequest{Content: "x"}, nil)
	if reason, _ := errReason(o.client); reason != "MESSAGE_NOT_EDITABLE" {
		t.Fatalf("edit reason: %q", reason)
	}
	o.must(204, "DELETE", "/api/messages/"+cp.GetId(), nil, nil)
	if st := fileStatus(t, stranger, f.GetId()); st != 404 {
		t.Fatalf("stranger reads the file after the copy is deleted: %d", st)
	}
	if st := fileStatus(t, bob, f.GetId()); st != 200 {
		t.Fatalf("the original lost its file: %d", st)
	}

	// Into a DM: no mention rows (the recipient's inbox stays empty); a copy of the copy points
	// at the original; the original room of a DM copy is disclosed only when not a DM.
	dcp := forwardMsg(t, o, roomA, src.GetId(), dm, 201)
	var mentions v1.ListMessagesResponse
	bob.must(200, "GET", "/api/me/mentions", nil, &mentions)
	for _, m := range mentions.GetMessages() {
		if m.GetId() == dcp.GetId() {
			t.Fatal("the DM copy is a mention")
		}
	}
	cc := forwardMsg(t, bob, dm, dcp.GetId(), roomA, 201)
	if cc.GetForward().GetMessageId() != src.GetId() || cc.GetForward().GetAuthorId() != o.id || cc.GetAuthorId() != bob.id {
		t.Fatalf("copy of a copy: %v", cc.GetForward())
	}
	o.must(200, "GET", "/api/rooms/"+roomA+"/messages", nil, &list)
	for _, m := range list.GetMessages() {
		if m.GetId() == src.GetId() || m.GetId() == cc.GetId() {
			continue
		}
		t.Fatalf("unexpected message in room A: %v", m)
	}
	o.must(200, "GET", "/api/me/mentions", nil, &mentions)
	for _, m := range mentions.GetMessages() {
		if m.GetId() == cc.GetId() {
			t.Fatal("the room copy with @everyone is a mention")
		}
	}
	if dc := forwardMsg(t, o, roomA, cc.GetId(), dm, 201); dc.GetForward().GetRoomId() != roomA { // from a room copy
		t.Fatalf("copy of a room copy: %v", dc.GetForward())
	}
	// A message of a DM forwarded to a room: its room stays undisclosed.
	dmMsg := dmPost(t, bob, dm, "личное")
	rc := forwardMsg(t, bob, dm, dmMsg.GetId(), roomA, 201)
	if rc.GetForward().GetRoomId() != "" || rc.GetForward().GetMessageId() != dmMsg.GetId() {
		t.Fatalf("DM origin disclosed: %v", rc.GetForward())
	}

	// Rights: SEND_MESSAGES in the target (403), VIEW_ROOM in the source and the target (404).
	forwardMsg(t, bob, roomA, src.GetId(), roomB, 403)
	forwardMsg(t, stranger, roomA, src.GetId(), roomC, 404)
	forwardMsg(t, bob, roomA, src.GetId(), roomC, 404)
	forwardMsg(t, o, roomB, src.GetId(), roomC, 404) // not a message of that room
	forwardMsg(t, o, roomA, uuid.NewString(), roomC, 404)
	bob.must(422, "POST", "/api/rooms/"+roomA+"/messages/"+src.GetId()+"/forward", &v1.ForwardMessageRequest{ToRoomId: "nope"}, nil)
	// Deleted: 404.
	gone := send(t, o, roomA, "уйдёт", uniq("fw"))
	o.must(204, "DELETE", "/api/messages/"+gone.GetId(), nil, nil)
	forwardMsg(t, o, roomA, gone.GetId(), roomC, 404)

	// A bot command is not forwarded (422 NOT_FORWARDABLE); plain slash text is.
	b := createBot(t, o, wid, "dice")
	b.must(200, "PUT", "/api/bots/me/commands", &v1.SetBotCommandsRequest{Commands: []*v1.BotCommand{{Name: "roll", Description: "Roll"}}}, nil)
	cmd := send(t, bob, roomA, "/roll 2d6", uniq("fw"))
	forwardMsg(t, o, roomA, cmd.GetId(), roomC, 422)
	if reason, _ := errReason(o.client); reason != "NOT_FORWARDABLE" {
		t.Fatalf("command reason: %q", reason)
	}
	forwardMsg(t, o, roomA, send(t, bob, roomA, "/usr/bin", uniq("fw")).GetId(), roomC, 201)
	// A bot forwards like a person, and the copy carries `forward` for bots too.
	bcp := forwardMsg(t, b, roomA, src.GetId(), roomA, 201)
	if bcp.GetForward().GetMessageId() != src.GetId() {
		t.Fatalf("bot copy: %v", bcp)
	}

	// From a restricted room (ADR-0029): allowed, it is the member's deliberate action.
	secret := textRoom(t, o, wid, "secret", true)
	on := true
	o.must(200, "PATCH", "/api/rooms/"+secret, &v1.UpdateRoomRequest{Restricted: &on}, nil)
	sm := send(t, o, secret, "секрет", uniq("fw"))
	forwardMsg(t, o, secret, sm.GetId(), roomA, 201)
	forwardMsg(t, bob, secret, sm.GetId(), roomA, 404) // bob does not see the restricted room
}

// TestForwardRecordingCard (ADR-0033 §4): a forwarded recording card follows the original
// (MESSAGE_UPDATE to the copy's room), its reader gets the audio and the transcript through the
// copy (not after the copy is deleted), and deleting the recording empties the copies.
func TestForwardRecordingCard(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	dave := register(t, invite(t, o, ws.GetId())) // a member denied VIEW_ROOM in the recorded room
	ovs := append(slices.Clone(room.GetPermissionOverrides()), userOv(dave.id, 0, perm.ViewRoom))
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
	pairWorkspace(t, o, ws.GetId())
	inCall(t, bob, ws, rid)
	dm := openDM(t, bob, dave.id, 201).GetRoom().GetId()
	g, dg := dialGW(t), dialGW(t)
	g.identify(o.token)
	dg.identify(dave.token)
	defer func() {
		gptFake.Lock()
		gptFake.Statuses, gptFake.Summary, gptFake.Language, gptFake.Transcript = nil, "", "", nil
		gptFake.Unlock()
	}()
	gptFake.Lock()
	gptFake.Statuses = []string{"done"}
	gptFake.Summary, gptFake.Language = "Итоги", "ru"
	gptFake.Transcript = []gptunneltest.Segment{{Start: 0, End: 1.5, Text: "Начнём."}}
	gptFake.Unlock()

	var start v1.StartRecordingResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
	recID := start.GetRecording().GetRecordingId()
	egressID := lastEgress(t, rid)
	egFake.mu.Lock()
	req := egFake.starts[len(egFake.starts)-1]
	egFake.mu.Unlock()
	local := filepath.Join(recordDir, strings.TrimPrefix(req.GetFileOutputs()[0].GetFilepath(), "/out/"))
	data := make([]byte, 32<<10)
	_, _ = rand.Read(data)
	if err := os.WriteFile(local, data, 0o600); err != nil {
		t.Fatal(err)
	}
	ended := egFake.end(egressID, int64(len(data)))
	if st := webhook(t, &livekit.WebhookEvent{Event: "egress_ended", Id: uniq("EV_eg"), CreatedAt: time.Now().Unix(), EgressInfo: ended}, "secret"); st != 200 {
		t.Fatalf("egress_ended: %d", st)
	}
	// Forwarded as soon as the card exists (uploading / processing): the copy catches up.
	cardMsg := g.wait("the card", func(e *v1.DispatchEvent) bool {
		return e.GetMessageCreate().GetMessage().GetSystem().GetRecording().GetRecordingId() == recID
	}).GetMessageCreate().GetMessage()
	cp := forwardMsg(t, bob, rid, cardMsg.GetId(), dm, 201)
	if cp.GetKind() != v1.MessageKind_MESSAGE_KIND_SYSTEM || cp.GetSystem().GetRecording().GetRecordingId() != recID || cp.GetForward().GetMessageId() != cardMsg.GetId() {
		t.Fatalf("card copy: %v", cp)
	}
	// Done with the audio in the copy too, however the forward raced the worker (updates after
	// it reach the copy's room as MESSAGE_UPDATE; before it, the copy starts done).
	var done *v1.Message
	for deadline := time.Now().Add(5 * time.Second); done == nil && time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		var hist v1.ListMessagesResponse
		dave.must(200, "GET", "/api/rooms/"+dm+"/messages", nil, &hist)
		for _, m := range hist.GetMessages() {
			c := m.GetSystem().GetRecording()
			if m.GetId() == cp.GetId() && c.GetStatus() == v1.RecordingStatus_RECORDING_STATUS_DONE && !c.GetResultPending() && len(m.GetAttachments()) == 1 {
				done = m
			}
		}
	}
	if done == nil {
		t.Fatal("the copy never got done with the audio")
	}
	fileID := done.GetAttachments()[0].GetId()
	tpath := "/api/rooms/" + dm + "/recordings/" + recID + "/transcript"
	if st := fileStatus(t, dave, fileID); st != 200 {
		t.Fatalf("dave reads the audio through the copy: %d", st)
	}
	dave.must(200, "GET", tpath, nil, nil)
	dave.must(404, "GET", "/api/rooms/"+rid+"/recordings/"+recID+"/transcript", nil, nil)
	dave.must(404, "DELETE", "/api/rooms/"+dm+"/recordings/"+recID, nil, nil) // only from the recording's room
	bob.must(404, "DELETE", "/api/rooms/"+dm+"/recordings/"+recID, nil, nil)
	// The copy deleted: no access left.
	dave.must(403, "DELETE", "/api/messages/"+cp.GetId(), nil, nil) // bob's message
	bob.must(204, "DELETE", "/api/messages/"+cp.GetId(), nil, nil)
	if st := fileStatus(t, dave, fileID); st != 404 {
		t.Fatalf("audio after the copy is deleted: %d", st)
	}
	dave.must(404, "GET", tpath, nil, nil)
	// Forwarded again, then the recording is deleted: the copy follows.
	cp = forwardMsg(t, bob, rid, cardMsg.GetId(), dm, 201)
	if len(cp.GetAttachments()) != 1 {
		t.Fatalf("copy of a done card: %v", cp.GetAttachments())
	}
	dave.must(200, "GET", tpath, nil, nil)
	bob.must(204, "DELETE", "/api/rooms/"+rid+"/recordings/"+recID, nil, nil)
	dg.wait("the copy shows the deletion", func(e *v1.DispatchEvent) bool {
		m := e.GetMessageUpdate().GetMessage()
		return m.GetId() == cp.GetId() && m.GetSystem().GetRecording().GetDeletedAt() != nil && len(m.GetAttachments()) == 0
	})
	dave.must(404, "GET", tpath, nil, nil)
	if st := fileStatus(t, dave, fileID); st != 404 {
		t.Fatalf("audio after the recording is deleted: %d", st)
	}
}
