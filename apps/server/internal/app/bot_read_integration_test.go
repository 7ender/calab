//go:build integration

package app_test

import (
	"context"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/perm"
)

// A bot may read the whole transcript with VIEW_ROOM alone. No recording-management
// permission is implied, and room scoping/deletion must still hide the recording.
func TestBotRecordingTranscriptAccess(t *testing.T) {
	o, _, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "reader")
	rid := room.GetId()
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(b.id, perm.ViewRoom, perm.SendMessages|perm.Connect),
	}}, nil)
	var recID string
	ctx := context.Background()
	err := testDB.Pool.QueryRow(ctx, `INSERT INTO room_recordings
		(workspace_id, room_id, started_by, status, result_state, language, transcript_json)
		VALUES ($1, $2, $3, 'done', 'ready', 'en', $4) RETURNING id`, ws.GetId(), rid, o.id,
		`[{"speaker":0,"start":0.48,"end":6.9,"text":"First segment."},{"speaker":1,"start":7.2,"end":12.05,"text":"Last segment."}]`).Scan(&recID)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/rooms/" + rid + "/recordings/" + recID + "/transcript"
	var got v1.GetRecordingTranscriptResponse
	b.must(200, "GET", path, nil, &got)
	segs := got.GetSegments()
	if got.GetRecordingId() != recID || got.GetLanguage() != "en" || len(segs) != 2 ||
		segs[0].GetText() != "First segment." || segs[0].GetStartMs() != 480 ||
		segs[1].GetText() != "Last segment." || segs[1].GetSpeaker() != 1 || segs[1].GetEndMs() != 12050 {
		t.Fatalf("full transcript: %v", &got)
	}
	otherRoom := textRoom(t, o, ws.GetId(), "other", false)
	b.must(404, "GET", "/api/rooms/"+otherRoom+"/recordings/"+recID+"/transcript", nil, nil)
	otherWS := createWorkspace(t, o, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE)
	foreign := createBot(t, o, otherWS.GetId(), "foreign")
	foreign.must(404, "GET", path, nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(b.id, 0, perm.ViewRoom),
	}}, nil)
	b.must(404, "GET", path, nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	// Retain the payload deliberately: the deletion gate, not erasure, must protect it.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET deleted_at = now() WHERE id = $1`, recID); err != nil {
		t.Fatal(err)
	}
	b.must(404, "GET", path, nil, nil)
}

// A point lookup returns the full existing Message, with the same caller-relative details
// as history. Reading another room's message or a deleted message must fail closed.
func TestGetMessageAccessAndDetails(t *testing.T) {
	o, bob, ws, room := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "message_reader")
	rid := room.GetId()
	ref := send(t, o, rid, "original", "")
	status, file, _ := upload(t, o, "/api/workspaces/"+ws.GetId()+"/files", "notes.txt", []byte("meeting notes"))
	if status != 201 {
		t.Fatalf("upload: %d", status)
	}
	var created v1.CreateMessageResponse
	o.must(201, "POST", "/api/rooms/"+rid+"/messages", &v1.CreateMessageRequest{
		Content: "reply", ReplyToId: ref.GetId(), AttachmentIds: []string{file.GetId()},
	}, &created)
	mid := created.GetMessage().GetId()
	b.must(204, "PUT", "/api/messages/"+mid+"/reactions/%F0%9F%91%8D", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(b.id, perm.ViewRoom, perm.SendMessages),
	}}, nil)
	path := "/api/rooms/" + rid + "/messages/" + mid
	var got v1.Message
	b.must(200, "GET", path, nil, &got)
	if got.GetId() != mid || got.GetRoomId() != rid || got.GetContent() != "reply" || got.GetReplyToId() != ref.GetId() ||
		len(got.GetAttachments()) != 1 || got.GetAttachments()[0].GetId() != file.GetId() ||
		len(got.GetReactions()) != 1 || !got.GetReactions()[0].GetMe() {
		t.Fatalf("message details: %v", &got)
	}
	var human v1.Message
	bob.must(200, "GET", path, nil, &human)
	if human.GetReactions()[0].GetMe() {
		t.Fatal("reaction me belongs to the requesting user")
	}
	otherRoom := textRoom(t, o, ws.GetId(), "other", false)
	b.must(404, "GET", "/api/rooms/"+otherRoom+"/messages/"+mid, nil, nil)
	b.must(404, "GET", "/api/rooms/"+rid+"/messages/not-an-id", nil, nil)
	b.must(404, "GET", "/api/rooms/"+rid+"/messages/00000000-0000-7000-8000-000000000000", nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		userOv(b.id, 0, perm.ViewRoom),
	}}, nil)
	b.must(404, "GET", path, nil, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{}, nil)
	o.must(204, "DELETE", "/api/messages/"+mid, nil, nil)
	b.must(404, "GET", path, nil, nil)

	// The reply target may be a recording card, even outside the first page of history.
	var systemID string
	if err := testDB.Pool.QueryRow(context.Background(), `INSERT INTO messages (room_id, author_id, content, kind, payload)
		VALUES ($1, $2, '', 'system', $3) RETURNING id`, rid, o.id,
		`{"recording":{"recordingId":"01890000-0000-7000-8000-00000000abcd","status":"RECORDING_STATUS_DONE","summary":"Meeting summary","hasTranscript":true}}`).Scan(&systemID); err != nil {
		t.Fatal(err)
	}
	var system v1.Message
	b.must(200, "GET", "/api/rooms/"+rid+"/messages/"+systemID, nil, &system)
	if system.GetSystem().GetRecording().GetSummary() != "Meeting summary" || !system.GetSystem().GetRecording().GetHasTranscript() {
		t.Fatalf("recording reply target: %v", &system)
	}
}

func TestGetMessageDMClearedHistory(t *testing.T) {
	o, bob, ws, _ := setupTeam(t)
	b := createBot(t, o, ws.GetId(), "dm_reader")
	rid := openDM(t, o, b.id, 201).GetRoom().GetId()
	before := dmPost(t, o, rid, "before mark")
	mark := dmPost(t, o, rid, "at mark")
	path := "/api/rooms/" + rid + "/messages/"
	b.must(200, "GET", path+before.GetId(), nil, nil)
	bob.must(404, "GET", path+before.GetId(), nil, nil)
	o.must(200, "PATCH", "/api/dms/"+rid+"/state", &v1.UpdateDmStateRequest{Cleared: true}, nil)
	fresh := dmPost(t, o, rid, "after mark")
	o.must(404, "GET", path+before.GetId(), nil, nil)
	o.must(404, "GET", path+mark.GetId(), nil, nil)
	o.must(200, "GET", path+fresh.GetId(), nil, nil)
	b.must(200, "GET", path+before.GetId(), nil, nil) // the other participant keeps history
}
