//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestRecordingRetry: a failed recording's card offers «Проверить снова» (recheck: poll
// GPTunneL again, the 2 h window anew) and «Отправить снова» (reupload while the local file
// is kept); GPTunneL's "failed: internal" and 5xx answers do not end the polling (backlog 40).
func TestRecordingRetry(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	pairWorkspace(t, o, ws.GetId())
	inCall(t, bob, ws, rid)
	g := dialGW(t)
	g.identify(o.token)
	ctx := context.Background()
	fake := func(f func()) {
		gptFake.Lock()
		defer gptFake.Unlock()
		f()
	}
	defer fake(func() { gptFake.Statuses, gptFake.FailError, gptFake.CreateError, gptFake.FailGets = nil, "", "", 0 })
	waitCard := func(what, recID string, ok func(*v1.RecordingCard) bool) *v1.RecordingCard {
		t.Helper()
		e := g.wait(what, func(e *v1.DispatchEvent) bool {
			c := card(e)
			return c.GetRecordingId() == recID && ok(c)
		})
		return card(e)
	}
	failedWith := func(code string) func(*v1.RecordingCard) bool {
		return func(c *v1.RecordingCard) bool {
			return c.GetStatus() == v1.RecordingStatus_RECORDING_STATUS_FAILED && c.GetError() == code
		}
	}
	isStatus := func(s v1.RecordingStatus) func(*v1.RecordingCard) bool {
		return func(c *v1.RecordingCard) bool { return c.GetStatus() == s }
	}
	// record starts a recording, writes its file and ends the egress (webhook).
	record := func() (recID, local string, data []byte) {
		t.Helper()
		var start v1.StartRecordingResponse
		bob.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
		recID = start.GetRecording().GetRecordingId()
		egressID := lastEgress(t, rid)
		egFake.mu.Lock()
		req := egFake.starts[len(egFake.starts)-1]
		egFake.mu.Unlock()
		local = filepath.Join(recordDir, strings.TrimPrefix(req.GetFileOutputs()[0].GetFilepath(), "/out/"))
		data = make([]byte, 32<<10)
		_, _ = rand.Read(data)
		if err := os.WriteFile(local, data, 0o600); err != nil {
			t.Fatal(err)
		}
		ended := egFake.end(egressID, int64(len(data)))
		if st := webhook(t, &livekit.WebhookEvent{Event: "egress_ended", Id: uniq("EV_eg"), CreatedAt: time.Now().Unix(), EgressInfo: ended}, "secret"); st != 200 {
			t.Fatalf("egress_ended: %d", st)
		}
		return recID, local, data
	}
	path := func(recID, action string) string { return "/api/rooms/" + rid + "/recordings/" + recID + "/" + action }

	// 1. Uploaded, then GPTunneL fails the processing: FAILED, both buttons possible.
	fake(func() { gptFake.Statuses, gptFake.FailError = []string{"failed"}, "transcription_failed" })
	recID, _, _ := record()
	c := waitCard("failed card", recID, failedWith("transcription_failed"))
	if c.GetNotUploaded() || c.GetFileGone() {
		t.Fatalf("failed card flags: %v", c)
	}

	// Rights: like start — a guest cannot, another room's path or an unknown id is 404.
	gus := register(t, invite(t, o, ws.GetId()))
	guest := v1.WorkspaceRole_WORKSPACE_ROLE_GUEST
	o.must(200, "PATCH", "/api/workspaces/"+ws.GetId()+"/members/"+gus.id, &v1.UpdateMemberRequest{Role: &guest}, nil)
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: []*v1.RoomPermissionOverride{
		{TargetType: v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE, TargetId: "guest", Allow: 1}, // VIEW_ROOM
	}}, nil)
	gus.must(403, "POST", path(recID, "recheck"), nil, nil)
	gus.must(403, "POST", path(recID, "reupload"), nil, nil)
	var other v1.CreateRoomResponse
	o.must(201, "POST", "/api/workspaces/"+ws.GetId()+"/rooms", &v1.CreateRoomRequest{Type: v1.RoomType_ROOM_TYPE_VOICE, Name: "other"}, &other)
	bob.must(404, "POST", "/api/rooms/"+other.GetRoom().GetId()+"/recordings/"+recID+"/recheck", nil, nil)
	bob.must(404, "POST", path(uuid.NewString(), "recheck"), nil, nil)
	// Delivered: never sent again, only rechecked.
	if st, e := bob.apiErrBody("POST", path(recID, "reupload"), nil); st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_ALREADY_UPLOADED {
		t.Fatalf("reupload of a delivered recording: %d %v", st, e)
	}

	// 2. Recheck, long after the first poll window: GPTunneL now reports "failed: internal"
	// and 502s — polling goes on; then done.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET processing_since = now() - interval '3 hours' WHERE id = $1`, recID); err != nil {
		t.Fatal(err)
	}
	fake(func() { gptFake.FailError, gptFake.FailGets = "internal", 2 })
	polls := func() int { r, _ := gptFake.ByClientID(recID); return r.Polls }
	before := polls()
	var rr v1.RetryRecordingResponse
	bob.must(200, "POST", path(recID, "recheck"), nil, &rr)
	if rr.GetRecording().GetStatus() != v1.RecordingStatus_RECORDING_STATUS_PROCESSING || rr.GetRecording().GetError() != "" {
		t.Fatalf("recheck answer: %v", rr.GetRecording())
	}
	waitCard("processing again", recID, isStatus(v1.RecordingStatus_RECORDING_STATUS_PROCESSING))
	if e := bob.rawErr("POST", path(recID, "recheck")); e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Fatalf("recheck while processing: %v", e)
	}
	deadline := time.Now().Add(10 * time.Second)
	for polls() < before+5 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if status, _, _, _ := recState(t, recID); status != "processing" || polls() < before+5 {
		t.Fatalf("after internal / 5xx: %s, %d polls", status, polls()-before)
	}
	fake(func() { gptFake.Statuses = []string{"done"} })
	c = waitCard("done after recheck", recID, isStatus(v1.RecordingStatus_RECORDING_STATUS_DONE))
	if !strings.HasPrefix(c.GetWebUrl(), "https://gptunnel.test/meetings/") {
		t.Fatalf("done card: %v", c)
	}
	if e := bob.rawErr("POST", path(recID, "reupload")); e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Fatalf("reupload of a done recording: %v", e)
	}

	// 3. Failed before reaching GPTunneL: recheck is 409 (not_uploaded), reupload sends the
	// file again as a new GPTunneL recording.
	fake(func() { gptFake.CreateError = "insufficient_balance" })
	recID, _, data := record()
	c = waitCard("balance card", recID, failedWith("insufficient_balance"))
	if !c.GetNotUploaded() || c.GetFileGone() {
		t.Fatalf("balance card flags: %v", c)
	}
	if e := bob.rawErr("POST", path(recID, "recheck")); e.GetCode() != v1.ErrorCode_ERROR_CODE_CONFLICT {
		t.Fatalf("recheck of a never uploaded recording: %v", e)
	}
	fake(func() { gptFake.CreateError = "" })
	// A GPTunneL id of an upload that did not complete does not count as delivered.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET gptunnel_id = 'partial' WHERE id = $1`, recID); err != nil {
		t.Fatal(err)
	}
	bob.must(200, "POST", path(recID, "reupload"), nil, &rr)
	if rr.GetRecording().GetStatus() != v1.RecordingStatus_RECORDING_STATUS_UPLOADING {
		t.Fatalf("reupload answer: %v", rr.GetRecording())
	}
	waitCard("done after reupload", recID, isStatus(v1.RecordingStatus_RECORDING_STATUS_DONE))
	up, ok := gptFake.ByClientID(recID + "#1")
	if !ok || !bytes.Equal(up.Data, data) {
		t.Fatalf("re-uploaded: ok=%v", ok)
	}

	// 4. The file is gone from the volume: reupload is 409 FILE_GONE and the card says so.
	fake(func() { gptFake.CreateError = "insufficient_balance" })
	recID, local, _ := record()
	waitCard("balance card 2", recID, failedWith("insufficient_balance"))
	if err := os.Remove(local); err != nil {
		t.Fatal(err)
	}
	if st, e := bob.apiErrBody("POST", path(recID, "reupload"), nil); st != 409 || e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_GONE {
		t.Fatalf("reupload without a file: %d %v", st, e)
	}
	waitCard("file gone card", recID, func(c *v1.RecordingCard) bool { return c.GetFileGone() })
	if _, _, _, deleted := recState(t, recID); !deleted {
		t.Fatal("file_deleted_at not set")
	}
	if e := bob.rawErr("POST", path(recID, "reupload")); e.GetCode() != v1.ErrorCode_ERROR_CODE_FILE_GONE {
		t.Fatalf("second reupload without a file: %v", e)
	}

	// Not connected to GPTunneL: 409 NOT_PAIRED.
	o.must(204, "DELETE", "/api/workspaces/"+ws.GetId()+"/integrations/gptunnel", nil, nil)
	if e := bob.rawErr("POST", path(recID, "reupload")); e.GetCode() != v1.ErrorCode_ERROR_CODE_NOT_PAIRED {
		t.Fatalf("reupload when not paired: %v", e)
	}
}
