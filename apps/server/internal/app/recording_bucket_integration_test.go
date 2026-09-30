//go:build integration

package app_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/blob/blobtest"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/events"
	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/recording"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/calaba/calaba/server/internal/rtc"
)

// holdRecordingWorker takes the lock of the app's recording worker (it works on the volume)
// until the test ends, so a service of the test drives the rows alone. A job the worker is
// running already gets a moment to finish.
func holdRecordingWorker(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	key := redisx.Key("rec:worker")
	if err := testRedis.Do(ctx, testRedis.B().Set().Key(key).Value("integration-test").Px(time.Minute).Build()).Error(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = testRedis.Do(ctx, testRedis.B().Del().Key(key).Build()).Error() })
	time.Sleep(time.Second)
}

// TestRecordingBucket: STORAGE_DRIVER=s3 — the egress uploads the recording into the files
// bucket and the service reads, checks and deletes it through the blob store under the key the
// database keeps (<workspace>/<recording>.mp4, as on the volume). A second recording service in
// bucket mode over the same database; its store is in memory.
func TestRecordingBucket(t *testing.T) {
	holdRecordingWorker(t)
	o, _, ws, room := setupTeam(t)
	pairWorkspace(t, o, ws.GetId())
	ctx := context.Background()
	defer func() {
		gptFake.Lock()
		gptFake.Statuses = nil
		gptFake.Unlock()
	}()
	gptFake.Lock()
	gptFake.Statuses = []string{"done"}
	gptFake.Unlock()

	mem := blobtest.New()
	gpt := gptunnel.New(testCfg.GPTunnelAPIURL)
	gpt.ChunkSize = 32 << 10 // several chunks: reads at offsets through the bucket
	svc := recording.New(recording.Config{
		MaxConcurrent: 2, Secret: []byte(testCfg.JWTSecret), WebURL: testCfg.GPTunnelWebURL,
		Bucket: &recording.Bucket{Store: mem, S3: blob.S3Config{Bucket: "files", KeyPrefix: "calab"}},
	}, testDB, testRedis, nil, gpt, events.Redis{C: testRedis})
	svc.SetFiles(testApp.Files)
	svc.PollMin, svc.ResultBackoff = 10*time.Millisecond, []time.Duration{10 * time.Millisecond}

	wsID, roomID, starter := uuid.MustParse(ws.GetId()), uuid.MustParse(room.GetId()), uuid.MustParse(o.id)
	// recordingRow inserts a row the way start does (no egress is asked: no LiveKit here).
	recordingRow := func() (sqlc.RoomRecording, string) {
		t.Helper()
		id := uuid.Must(uuid.NewV7())
		egressID := uniq("EG_bucket")
		if _, err := testDB.Q.InsertRecording(ctx, sqlc.InsertRecordingParams{
			ID: id, WorkspaceID: wsID, RoomID: roomID, StartedBy: &starter, File: wsID.String() + "/" + id.String() + ".mp4",
		}); err != nil {
			t.Fatal(err)
		}
		rec, err := testDB.Q.MarkRecordingStarted(ctx, sqlc.MarkRecordingStartedParams{ID: id, EgressID: &egressID})
		if err != nil {
			t.Fatal(err)
		}
		return rec, egressID
	}
	ended := func(egressID string) *rtc.EgressInfo {
		return &rtc.EgressInfo{EgressID: egressID, Status: rtc.EgressComplete, Files: []rtc.FileResult{{Duration: 65 * time.Second}}}
	}

	// Happy path: the object is there → upload to GPTunneL → done → the audio is kept as an
	// attachment and the object leaves the bucket.
	rec, egressID := recordingRow()
	data := make([]byte, 100<<10)
	_, _ = rand.Read(data)

	// The bucket does not answer: nothing is decided, the row waits for the next reconcile.
	mem.Set(rec.File, data)
	mem.Fail(errors.New("connection refused"))
	if err := svc.HandleEgress(ctx, rtc.EventEgressEnded, ended(egressID)); err == nil {
		t.Fatal("egress ended while the bucket is down: no error")
	}
	if st, _, _, _ := recState(t, rec.ID.String()); st != "recording" {
		t.Fatalf("bucket down: status %s", st)
	}
	mem.Fail(nil)

	if err := svc.HandleEgress(ctx, rtc.EventEgressEnded, ended(egressID)); err != nil {
		t.Fatal(err)
	}
	var size int64
	if err := testDB.Pool.QueryRow(ctx, `SELECT size_bytes FROM room_recordings WHERE id = $1`, rec.ID).Scan(&size); err != nil || size != int64(len(data)) {
		t.Fatalf("size from the bucket: %d %v", size, err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := svc.ProcessOnce(ctx); err != nil {
			t.Fatal(err)
		}
		st, code, _, deleted := recState(t, rec.ID.String())
		if st == "done" && deleted {
			break
		}
		if st == "failed" || time.Now().After(deadline) {
			t.Fatalf("status %s (%s), file deleted %v", st, code, deleted)
		}
		time.Sleep(20 * time.Millisecond)
	}
	up, ok := gptFake.ByClientID(rec.ID.String())
	if !ok || !bytes.Equal(up.Data, data) {
		t.Fatalf("uploaded to GPTunneL: %v, %d bytes", ok, len(up.Data))
	}
	if mem.Has(rec.File) {
		t.Fatal("the recording is still in the bucket")
	}
	var fileID *uuid.UUID
	if err := testDB.Pool.QueryRow(ctx, `SELECT file_id FROM room_recordings WHERE id = $1`, rec.ID).Scan(&fileID); err != nil || fileID == nil {
		t.Fatalf("audio attachment: %v %v", fileID, err)
	}
	r, _, err := testStore.Get(ctx, blob.FileKey(wsID, *fileID))
	if err != nil {
		t.Fatal(err)
	}
	kept, err := io.ReadAll(r)
	_ = r.Close()
	if err != nil || !bytes.Equal(kept, data) {
		t.Fatalf("kept audio: %d bytes, %v", len(kept), err)
	}

	// Missing object: the egress ended without uploading anything.
	rec, egressID = recordingRow()
	if err := svc.HandleEgress(ctx, rtc.EventEgressEnded, ended(egressID)); err != nil {
		t.Fatal(err)
	}
	if st, code, _, _ := recState(t, rec.ID.String()); st != "failed" || code != "no_audio" {
		t.Fatalf("no object: %s %s", st, code)
	}
	failed := &rtc.EgressInfo{EgressID: "", Status: rtc.EgressFailed, Error: "upload failed"}
	rec, failed.EgressID = recordingRow()
	if err := svc.HandleEgress(ctx, rtc.EventEgressEnded, failed); err != nil {
		t.Fatal(err)
	}
	if st, code, _, _ := recState(t, rec.ID.String()); st != "failed" || code != "recorder_failed" {
		t.Fatalf("egress failed: %s %s", st, code)
	}

	// The bucket stays down past StorageWait after the stop: the recording fails, so the room
	// is not held «recording» (the janitor removes the object later, if there is one).
	rec, egressID = recordingRow()
	if _, err := testDB.Pool.Exec(ctx, `UPDATE room_recordings SET stopped_at = now() - interval '31 minutes' WHERE id = $1`, rec.ID); err != nil {
		t.Fatal(err)
	}
	mem.Fail(errors.New("connection refused"))
	defer mem.Fail(nil)
	if err := svc.HandleEgress(ctx, rtc.EventEgressEnded, ended(egressID)); err != nil {
		t.Fatal(err)
	}
	if st, code, _, _ := recState(t, rec.ID.String()); st != "failed" || code != "recorder_failed" {
		t.Fatalf("bucket down for good: %s %s", st, code)
	}
}
