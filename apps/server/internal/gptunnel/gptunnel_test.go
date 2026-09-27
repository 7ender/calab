package gptunnel_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/calaba/calaba/server/internal/gptunnel"
	"github.com/calaba/calaba/server/internal/gptunnel/gptunneltest"
)

func setup(t *testing.T) (*gptunneltest.Server, *gptunnel.Client, string) {
	t.Helper()
	fake := gptunneltest.New()
	t.Cleanup(fake.Close)
	c := gptunnel.New(fake.URL)
	c.ChunkSize = 1000
	c.Backoff = func(int) time.Duration { return 0 }
	fake.AddCode("ABCD-EFGH")
	s, err := c.Pair(context.Background(), gptunnel.PairRequest{Code: "abcd efgh", Name: "Calab · Team", Platform: "linux", AppVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if s.Device.Name == "" || s.User.Label() != "Test Account" || s.WebURL == "" {
		t.Fatalf("session: %+v", s)
	}
	return fake, c, s.Token
}

func blob(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func req(id string, size int) gptunnel.CreateRequest {
	return gptunnel.CreateRequest{ClientID: id, Title: "Meeting", Kind: "video", Mime: "video/mp4", SizeBytes: int64(size),
		DurationSec: 60, StartedAt: time.Now().UTC().Format(time.RFC3339)}
}

func TestPairErrors(t *testing.T) {
	fake, c, _ := setup(t)
	_, err := c.Pair(context.Background(), gptunnel.PairRequest{Code: "ABCD-EFGH", Name: "x", Platform: "linux"})
	if e, ok := gptunnel.AsError(err); !ok || e.Code != gptunnel.CodeInvalidCode || e.Retryable() {
		t.Fatalf("used code: %v", err) // one-time
	}
	// Not the device API at this address (HTML 404): server_unsupported, not retryable.
	other := gptunnel.New(fake.URL + "/elsewhere")
	_, err = other.Pair(context.Background(), gptunnel.PairRequest{Code: "X", Name: "x", Platform: "linux"})
	if e, ok := gptunnel.AsError(err); !ok || e.Code != gptunnel.CodeServerUnsupported {
		t.Fatalf("wrong base: %v", err)
	}
	// Unreachable: network, retryable.
	dead := gptunnel.New("http://127.0.0.1:1")
	_, err = dead.Me(context.Background(), "t")
	if e, ok := gptunnel.AsError(err); !ok || e.Code != gptunnel.CodeNetwork || !e.Retryable() {
		t.Fatalf("network: %v", err)
	}
}

func TestUploadChunksAndComplete(t *testing.T) {
	fake, c, tok := setup(t)
	data := blob(3500) // 4 chunks: 1000, 1000, 1000, 500
	var got string
	st, err := c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-1", len(data)), "", func(id string) error { got = id; return nil })
	if err != nil {
		t.Fatal(err)
	}
	rec, ok := fake.ByClientID("cid-1")
	if !ok || rec.ID != got || st.ID != got || !rec.Completed || rec.Puts != 4 || !bytes.Equal(rec.Data, data) {
		t.Fatalf("upload: ok=%v id=%s/%s completed=%v puts=%d equal=%v", ok, rec.ID, got, rec.Completed, rec.Puts, bytes.Equal(rec.Data, data))
	}
	if st.Status != gptunnel.StatusUploaded || st.WebURL == "" {
		t.Fatalf("status: %+v", st)
	}
}

func TestUploadResumes(t *testing.T) {
	fake, c, tok := setup(t)
	data := blob(2500)
	// First attempt: the server fails every PUT after the first chunk (more than MaxRetries).
	c.MaxRetries = 2
	fake.Lock()
	fake.FailPuts = 0
	fake.Unlock()
	ctx := context.Background()
	id, _, err := c.CreateRecording(ctx, tok, req("cid-2", len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if off, conflict, err := c.PutChunk(ctx, tok, id, 0, data[:1000], int64(len(data))); err != nil || conflict || off != 1000 {
		t.Fatalf("first chunk: %d %v %v", off, conflict, err)
	}
	fake.Lock()
	fake.FailPuts = 10
	fake.Unlock()
	_, err = c.Upload(ctx, tok, bytes.NewReader(data), req("cid-2", len(data)), id, nil)
	if e, ok := gptunnel.AsError(err); !ok || e.Status != 503 {
		t.Fatalf("expected 503 after retries, got %v", err)
	}
	fake.Lock()
	fake.FailPuts = 0
	fake.Unlock()
	// A wrong offset is corrected by the server's 409.
	if off, conflict, err := c.PutChunk(ctx, tok, id, 2000, data[2000:], int64(len(data))); err != nil || !conflict || off != 1000 {
		t.Fatalf("out of order chunk: %d %v %v", off, conflict, err)
	}
	// Second attempt resumes at the server's offset (HEAD), not at 0.
	fake.Lock()
	fake.FailPuts = 1 // one transient failure is retried within the attempt
	fake.Unlock()
	if _, err := c.Upload(ctx, tok, bytes.NewReader(data), req("cid-2", len(data)), id, nil); err != nil {
		t.Fatal(err)
	}
	rec, _ := fake.ByClientID("cid-2")
	if !bytes.Equal(rec.Data, data) || rec.Puts != 3 || !rec.Completed {
		t.Fatalf("resume: puts=%d equal=%v completed=%v", rec.Puts, bytes.Equal(rec.Data, data), rec.Completed)
	}
}

func TestUploadStartsOverWhenServerLostBytes(t *testing.T) {
	fake, c, tok := setup(t)
	data := blob(2200)
	fake.Lock()
	fake.LoseOffset = true // the first PUT: 409, Upload-Offset 0
	fake.Unlock()
	if _, err := c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-3", len(data)), "", nil); err != nil {
		t.Fatal(err)
	}
	rec, _ := fake.ByClientID("cid-3")
	if !bytes.Equal(rec.Data, data) {
		t.Fatal("data differs after starting over")
	}
	// A recording lost on the server (404 on HEAD) is created again with the same client_id.
	if _, err := c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-4", len(data)), "rec-unknown", nil); err != nil {
		t.Fatal(err)
	}
	if _, ok := fake.ByClientID("cid-4"); !ok {
		t.Fatal("not recreated")
	}
}

func TestUploadPermanentErrors(t *testing.T) {
	fake, c, tok := setup(t)
	data := blob(100)
	fake.Lock()
	fake.CreateError = gptunnel.CodeInsufficientBalance
	fake.Unlock()
	_, err := c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-5", len(data)), "", nil)
	if e, ok := gptunnel.AsError(err); !ok || e.Code != gptunnel.CodeInsufficientBalance || e.Retryable() {
		t.Fatalf("balance: %v", err)
	}
	fake.Lock()
	fake.CreateError = ""
	fake.Unlock()
	fake.RevokeAll()
	_, err = c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-5", len(data)), "", nil)
	if e, ok := gptunnel.AsError(err); !ok || !e.Unauthorized() || e.Code != gptunnel.CodeDeviceRevoked {
		t.Fatalf("revoked: %v", err)
	}
	// Cancellation is returned as is.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Upload(ctx, tok, bytes.NewReader(data), req("cid-6", len(data)), "", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestStatusPoll(t *testing.T) {
	fake, c, tok := setup(t)
	data := blob(10)
	st, err := c.Upload(context.Background(), tok, bytes.NewReader(data), req("cid-7", len(data)), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	fake.Lock()
	fake.Statuses = []string{"transcribing", "failed"}
	fake.FailError = gptunnel.CodeInsufficientBalance
	fake.Unlock()
	s1, err := c.Recording(context.Background(), tok, st.ID)
	if err != nil || s1.Status != gptunnel.StatusTranscribing || s1.ErrorCode() != "" {
		t.Fatalf("poll 1: %+v %v", s1, err)
	}
	s2, err := c.Recording(context.Background(), tok, st.ID)
	if err != nil || s2.Status != gptunnel.StatusFailed || s2.ErrorCode() != gptunnel.CodeInsufficientBalance {
		t.Fatalf("poll 2: %+v %v", s2, err)
	}
	if err := c.Revoke(context.Background(), tok); err != nil {
		t.Fatal(err)
	}
	if fake.TokenActive(tok) {
		t.Fatal("token still active after revoke")
	}
}
