//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/gptunnel/gptunneltest"
	"github.com/calaba/calaba/server/internal/perm"
)

// TestRecordingResult: after GPTunneL reports done the card gets the recording's audio (an
// audio/mp4 attachment, RECORDING_KEEP_DAYS), the summary and the transcript (docs/09 #47,
// docs/17); only who sees the room reads them; «Удалить запись» (#50) — who may, what goes.
func TestRecordingResult(t *testing.T) {
	liveKitUp(t)
	o, bob, ws, room := setupTeam(t)
	rid := room.GetId()
	carol := register(t, invite(t, o, ws.GetId())) // a member: sees the room, no MANAGE_MESSAGES
	dave := register(t, invite(t, o, ws.GetId()))  // a member denied VIEW_ROOM here
	stranger := register(t, invite(t, owner(t), createWorkspace(t, owner(t), v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE).GetId()))
	ovs := append(slices.Clone(room.GetPermissionOverrides()), userOv(dave.id, 0, perm.ViewRoom))
	o.must(200, "PUT", "/api/rooms/"+rid+"/permissions", &v1.SetRoomPermissionsRequest{Overrides: ovs}, nil)
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
	defer fake(func() {
		gptFake.Statuses, gptFake.Summary, gptFake.Language, gptFake.Transcript = nil, "", "", nil
		gptFake.NoResultAPI, gptFake.FailResults, gptFake.PageSize = false, 0, 0
	})
	one := 1
	zero := 0
	fake(func() {
		gptFake.Statuses = []string{"done"}
		gptFake.Summary, gptFake.Language, gptFake.PageSize = "## Темы\n- Релиз **0.7**", "ru", 2
		gptFake.Transcript = []gptunneltest.Segment{
			{Speaker: &zero, Start: 0.48, End: 6.9, Text: "Коллеги, начнём."},
			{Speaker: &one, Start: 7.2, End: 12.05, Text: "Эталоны пересняли."},
			{Speaker: nil, Start: 12.5, End: 13, Text: "Угу."},
		}
		gptFake.FailResults = 1 // one 503: retried
	})
	record := func() (recID, msgID, local string, data []byte) {
		t.Helper()
		var start v1.StartRecordingResponse
		bob.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
		recID = start.GetRecording().GetRecordingId()
		egressID := lastEgress(t, rid)
		egFake.mu.Lock()
		req := egFake.starts[len(egFake.starts)-1]
		egFake.mu.Unlock()
		local = filepath.Join(recordDir, strings.TrimPrefix(req.GetFileOutputs()[0].GetFilepath(), "/out/"))
		data = make([]byte, 48<<10)
		_, _ = rand.Read(data)
		if err := os.WriteFile(local, data, 0o600); err != nil {
			t.Fatal(err)
		}
		ended := egFake.end(egressID, int64(len(data)))
		if st := webhook(t, &livekit.WebhookEvent{Event: "egress_ended", Id: uniq("EV_eg"), CreatedAt: time.Now().Unix(), EgressInfo: ended}, "secret"); st != 200 {
			t.Fatalf("egress_ended: %d", st)
		}
		e := g.wait("card with the result", func(e *v1.DispatchEvent) bool {
			c := card(e)
			return c.GetRecordingId() == recID && c.GetStatus() == v1.RecordingStatus_RECORDING_STATUS_DONE && !c.GetResultPending()
		})
		return recID, e.GetMessageUpdate().GetMessage().GetId(), local, data
	}

	recID, msgID, local, data := record()
	// The card: summary, transcript, audio; the web link on GPTUNNEL_WEB_URL only for gptunnel.ai.
	var list v1.ListMessagesResponse
	bob.must(200, "GET", "/api/rooms/"+rid+"/messages", nil, &list)
	var msg *v1.Message
	for _, m := range list.GetMessages() {
		if m.GetId() == msgID {
			msg = m
		}
	}
	c := msg.GetSystem().GetRecording()
	if c.GetSummary() != "## Темы\n- Релиз **0.7**" || !c.GetHasTranscript() || c.GetAudioUntil() == nil ||
		time.Until(c.GetAudioUntil().AsTime()) < 29*24*time.Hour || !strings.HasPrefix(c.GetWebUrl(), "https://gptunnel.test/meetings/") {
		t.Fatalf("card: %v", c)
	}
	if len(msg.GetAttachments()) != 1 || msg.GetAttachments()[0].GetMime() != "audio/mp4" || !strings.HasSuffix(msg.GetAttachments()[0].GetName(), ".m4a") {
		t.Fatalf("attachments: %v", msg.GetAttachments())
	}
	fileID := msg.GetAttachments()[0].GetId()
	if _, err := os.Stat(local); !os.IsNotExist(err) {
		t.Fatalf("local file kept: %v", err)
	}
	// The audio: whoever sees the room downloads exactly the recording; others get 404.
	carol.must(200, "GET", "/api/files/"+fileID, nil, nil)
	if !bytes.Equal(carol.lastBody, data) {
		t.Fatalf("audio differs: %d bytes", len(carol.lastBody))
	}
	dave.must(404, "GET", "/api/files/"+fileID, nil, nil)
	stranger.must(404, "GET", "/api/files/"+fileID, nil, nil)
	// The transcript: VIEW_ROOM only.
	tpath := "/api/rooms/" + rid + "/recordings/" + recID + "/transcript"
	var tr v1.GetRecordingTranscriptResponse
	carol.must(200, "GET", tpath, nil, &tr)
	segs := tr.GetSegments()
	if tr.GetLanguage() != "ru" || len(segs) != 3 || segs[0].GetStartMs() != 480 || segs[1].GetSpeaker() != 1 || segs[1].GetEndMs() != 12050 ||
		segs[2].GetSpeaker() != -1 || segs[0].GetText() != "Коллеги, начнём." {
		t.Fatalf("transcript: %v", &tr)
	}
	dave.must(404, "GET", tpath, nil, nil)
	stranger.must(404, "GET", tpath, nil, nil)

	// An older GPTunneL (no result methods): the card keeps the audio and the link only.
	fake(func() { gptFake.NoResultAPI = true })
	rec2, _, _, _ := record()
	var st, lang string
	var tj []byte
	if err := testDB.Pool.QueryRow(ctx, `SELECT result_state, language, transcript_json FROM room_recordings WHERE id = $1`, rec2).Scan(&st, &lang, &tj); err != nil {
		t.Fatal(err)
	}
	if st != "unavailable" || tj != nil {
		t.Fatalf("no result API: %s %s", st, tj)
	}
	bob.must(404, "GET", "/api/rooms/"+rid+"/recordings/"+rec2+"/transcript", nil, nil)
	fake(func() { gptFake.NoResultAPI = false })

	// Audio expiry (RECORDING_KEEP_DAYS): the file and the attachment go, the card follows.
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET done_at = now() - interval '31 days' WHERE id = $1`, rec2); err != nil {
		t.Fatal(err)
	}
	testApp.Recording.Janitor(ctx)
	g.wait("card without audio", func(e *v1.DispatchEvent) bool {
		c := card(e)
		return c.GetRecordingId() == rec2 && c.GetAudioUntil() == nil && len(e.GetMessageUpdate().GetMessage().GetAttachments()) == 0
	})

	// Delete (#50): not a plain member, not who cannot see the room; the starter may.
	dpath := "/api/rooms/" + rid + "/recordings/" + recID
	carol.must(403, "DELETE", dpath, nil, nil)
	dave.must(404, "DELETE", dpath, nil, nil)
	stranger.must(404, "DELETE", dpath, nil, nil)
	var deletes int
	fake(func() { deletes = gptFake.DeleteCalled })
	bob.must(204, "DELETE", dpath, nil, nil)
	e := g.wait("card deleted", func(e *v1.DispatchEvent) bool {
		c := card(e)
		return c.GetRecordingId() == recID && c.GetDeletedAt() != nil
	})
	dc := card(e)
	if dc.GetDeletedBy() != bob.id || dc.GetSummary() != "" || dc.GetHasTranscript() || dc.GetWebUrl() != "" || dc.GetAudioUntil() != nil ||
		len(e.GetMessageUpdate().GetMessage().GetAttachments()) != 0 {
		t.Fatalf("deleted card: %v", e.GetMessageUpdate().GetMessage())
	}
	fake(func() { deletes = gptFake.DeleteCalled - deletes })
	if deletes != 1 {
		t.Fatal("not deleted in GPTunneL")
	}
	bob.must(404, "GET", "/api/files/"+fileID, nil, nil)
	bob.must(404, "GET", tpath, nil, nil)
	bob.must(404, "DELETE", dpath, nil, nil)
	// The owner deletes somebody else's recording; a running one is stopped first (409).
	var start v1.StartRecordingResponse
	bob.must(200, "POST", "/api/rooms/"+rid+"/recording/start", nil, &start)
	o.must(409, "DELETE", "/api/rooms/"+rid+"/recordings/"+start.GetRecording().GetRecordingId(), nil, nil)
	o.must(200, "POST", "/api/rooms/"+rid+"/recording/stop", nil, nil)
	ended := egFake.end(lastEgress(t, rid), 0) // no file: FAILED no_audio
	if st := webhook(t, &livekit.WebhookEvent{Event: "egress_ended", Id: uniq("EV_eg"), CreatedAt: time.Now().Unix(), EgressInfo: ended}, "secret"); st != 200 {
		t.Fatalf("egress_ended: %d", st)
	}
	o.must(204, "DELETE", "/api/rooms/"+rid+"/recordings/"+start.GetRecording().GetRecordingId(), nil, nil)
	o.must(204, "DELETE", "/api/rooms/"+rid+"/recordings/"+rec2, nil, nil)
}
