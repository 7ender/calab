package blob

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// testStoreContract checks the Store contract (blob.go) on s. Every driver runs it: fs and the
// s3 driver over a fake in unit tests, the s3 driver against a real S3 in integration tests.
// Payloads above 5 MiB make the s3 driver use multipart uploads.
func testStoreContract(t *testing.T, s Store) {
	t.Run("RoundTrip", func(t *testing.T) { contractRoundTrip(t, s) })
	t.Run("Empty", func(t *testing.T) { contractEmpty(t, s) })
	t.Run("SizeMismatch", func(t *testing.T) { contractSizeMismatch(t, s) })
	t.Run("ReaderError", func(t *testing.T) { contractReaderError(t, s) })
	t.Run("CancelledContext", func(t *testing.T) { contractCancelled(t, s) })
	t.Run("InvalidKey", func(t *testing.T) { contractInvalidKey(t, s) })
	t.Run("Large", func(t *testing.T) { contractLarge(t, s) })
	t.Run("Seek", func(t *testing.T) { contractSeek(t, s) })
	t.Run("ServeContent", func(t *testing.T) { contractServeContent(t, s) })
}

func newKey() string { return FileKey(uuid.New(), uuid.New()) }

func randomBytes(t *testing.T, n int) []byte {
	t.Helper()
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return b
}

func mustPut(t *testing.T, s Store, key string, data []byte, size int64) {
	t.Helper()
	if err := s.Put(context.Background(), key, bytes.NewReader(data), size, "application/octet-stream"); err != nil {
		t.Fatalf("put %d bytes (declared %d): %v", len(data), size, err)
	}
}

func readAll(t *testing.T, s Store, key string) []byte {
	t.Helper()
	r, m, err := s.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = r.Close() }()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if m.Size != int64(len(b)) {
		t.Fatalf("meta size %d, read %d bytes", m.Size, len(b))
	}
	return b
}

func assertMissing(t *testing.T, s Store, key string) {
	t.Helper()
	if _, err := s.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stat %s: %v, want ErrNotFound", key, err)
	}
	if _, _, err := s.Get(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get %s: %v, want ErrNotFound", key, err)
	}
}

func contractRoundTrip(t *testing.T, s Store) {
	ctx := context.Background()
	key := newKey()
	data := []byte("hello, calaba")
	if err := s.Put(ctx, key, bytes.NewReader(data), int64(len(data)), "text/plain"); err != nil {
		t.Fatal(err)
	}
	m, err := s.Stat(ctx, key)
	if err != nil || m.Size != int64(len(data)) || m.ModTime.IsZero() {
		t.Fatalf("stat: %+v %v", m, err)
	}
	r, m, err := s.Get(ctx, key)
	if err != nil || m.Size != int64(len(data)) {
		t.Fatalf("get: %+v %v", m, err)
	}
	if _, err := r.Seek(7, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	rest, err := io.ReadAll(r)
	_ = r.Close()
	if err != nil || string(rest) != "calaba" {
		t.Fatalf("after seek: %q %v", rest, err)
	}
	// Overwrite with unknown size.
	if err := s.Put(ctx, key, strings.NewReader("v2"), -1, ""); err != nil {
		t.Fatal(err)
	}
	if got := readAll(t, s, key); string(got) != "v2" {
		t.Fatalf("overwrite: %q", got)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatalf("second delete: %v", err)
	}
	assertMissing(t, s, key)
}

func contractEmpty(t *testing.T, s Store) {
	for _, size := range []int64{0, -1} {
		key := newKey()
		mustPut(t, s, key, nil, size)
		if got := readAll(t, s, key); len(got) != 0 {
			t.Fatalf("size %d: read %d bytes", size, len(got))
		}
		_ = s.Delete(context.Background(), key)
	}
}

func contractSizeMismatch(t *testing.T, s Store) {
	ctx := context.Background()
	key := newKey()
	for _, n := range []int64{3, 100} { // declared smaller and larger than actual
		if err := s.Put(ctx, key, strings.NewReader("hello"), n, ""); !errors.Is(err, ErrSizeMismatch) {
			t.Fatalf("declared %d: %v", n, err)
		}
	}
	assertMissing(t, s, key)
	// A failed Put leaves an existing object as it was.
	mustPut(t, s, key, []byte("old"), 3)
	if err := s.Put(ctx, key, strings.NewReader("new data"), 3, ""); !errors.Is(err, ErrSizeMismatch) {
		t.Fatalf("overwrite: %v", err)
	}
	if got := readAll(t, s, key); string(got) != "old" {
		t.Fatalf("existing object changed: %q", got)
	}
	_ = s.Delete(ctx, key)
}

// failingReader yields n bytes of data, then fails with errBoom.
type failingReader struct{ n int }

var errBoom = errors.New("boom")

func (f *failingReader) Read(p []byte) (int, error) {
	if f.n == 0 {
		return 0, errBoom
	}
	n := min(len(p), f.n)
	clear(p[:n])
	f.n -= n
	return n, nil
}

// The reader's error reaches the caller (files.receive tells "too large" by it) and nothing is
// stored, also when it comes after the first multipart part.
func contractReaderError(t *testing.T, s Store) {
	for _, n := range []int{1 << 10, 6 << 20} {
		for _, size := range []int64{-1, int64(n) + 10} {
			key := newKey()
			err := s.Put(context.Background(), key, &failingReader{n: n}, size, "")
			if !errors.Is(err, errBoom) {
				t.Fatalf("%d bytes, declared %d: %v, want errBoom", n, size, err)
			}
			assertMissing(t, s, key)
		}
	}
}

func contractCancelled(t *testing.T, s Store) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	key := newKey()
	if err := s.Put(ctx, key, strings.NewReader("x"), 1, ""); err == nil {
		t.Fatal("put with cancelled ctx succeeded")
	}
	assertMissing(t, s, key)
}

func contractInvalidKey(t *testing.T, s Store) {
	ctx := context.Background()
	for _, key := range []string{"", "../escape", "a//b", ".hidden", "a b"} {
		if err := s.Put(ctx, key, strings.NewReader("x"), 1, ""); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("put %q: %v", key, err)
		}
		if _, _, err := s.Get(ctx, key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("get %q: %v", key, err)
		}
		if _, err := s.Stat(ctx, key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("stat %q: %v", key, err)
		}
		if err := s.Delete(ctx, key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("delete %q: %v", key, err)
		}
	}
}

func contractLarge(t *testing.T, s Store) {
	ctx := context.Background()
	data := randomBytes(t, 12<<20+123) // three parts of 5 MiB, the last one short
	for _, size := range []int64{int64(len(data)), -1} {
		key := newKey()
		mustPut(t, s, key, data, size)
		if got := readAll(t, s, key); !bytes.Equal(got, data) {
			t.Fatalf("declared %d: content differs (%d bytes read)", size, len(got))
		}
		// A read across the first part boundary.
		r, _, err := s.Get(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		off := int64(5<<20 - 10)
		if _, err := r.Seek(off, io.SeekStart); err != nil {
			t.Fatal(err)
		}
		buf := make([]byte, 20)
		if _, err := io.ReadFull(r, buf); err != nil || !bytes.Equal(buf, data[off:off+20]) {
			t.Fatalf("read at %d: %v", off, err)
		}
		_ = r.Close()
		_ = s.Delete(ctx, key)
	}
	// Mismatches found after the first part: nothing is stored.
	for _, size := range []int64{7 << 20, int64(len(data)) + 1} {
		key := newKey()
		if err := s.Put(ctx, key, bytes.NewReader(data), size, ""); !errors.Is(err, ErrSizeMismatch) {
			t.Fatalf("declared %d of %d: %v", size, len(data), err)
		}
		assertMissing(t, s, key)
	}
}

func contractSeek(t *testing.T, s Store) {
	ctx := context.Background()
	key := newKey()
	data := []byte("0123456789")
	mustPut(t, s, key, data, int64(len(data)))
	defer func() { _ = s.Delete(ctx, key) }()
	r, _, err := s.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close() }()
	read := func(n int) string {
		t.Helper()
		b := make([]byte, n)
		k, err := io.ReadFull(r, b)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
			t.Fatalf("read: %v", err)
		}
		return string(b[:k])
	}
	if got := read(3); got != "012" {
		t.Fatalf("start: %q", got)
	}
	if pos, err := r.Seek(2, io.SeekCurrent); err != nil || pos != 5 {
		t.Fatalf("seek current: %d %v", pos, err)
	}
	if got := read(2); got != "56" {
		t.Fatalf("after seek current: %q", got)
	}
	if pos, err := r.Seek(-3, io.SeekEnd); err != nil || pos != 7 {
		t.Fatalf("seek end: %d %v", pos, err)
	}
	if got := read(10); got != "789" {
		t.Fatalf("after seek end: %q", got)
	}
	if _, err := r.Seek(1, io.SeekStart); err != nil { // back, after the end was reached
		t.Fatal(err)
	}
	if got := read(2); got != "12" {
		t.Fatalf("seek back: %q", got)
	}
	if _, err := r.Seek(20, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	if n, err := r.Read(make([]byte, 4)); n != 0 || err != io.EOF {
		t.Fatalf("read past the end: %d %v", n, err)
	}
	if _, err := r.Seek(-1, io.SeekStart); err == nil {
		t.Fatal("negative position accepted")
	}
}

// contractServeContent serves the object the way files.serve does.
func contractServeContent(t *testing.T, s Store) {
	ctx := context.Background()
	key := newKey()
	data := randomBytes(t, 100<<10)
	mustPut(t, s, key, data, int64(len(data)))
	defer func() { _ = s.Delete(ctx, key) }()
	serve := func(method, rng string) *httptest.ResponseRecorder {
		t.Helper()
		r, _, err := s.Get(ctx, key)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = r.Close() }()
		req := httptest.NewRequestWithContext(ctx, method, "/f", nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		w := httptest.NewRecorder()
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, req, "", time.Time{}, r)
		return w
	}
	if w := serve(http.MethodGet, ""); w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatalf("full: %d, %d bytes", w.Code, w.Body.Len())
	}
	if w := serve(http.MethodHead, ""); w.Code != http.StatusOK || w.Header().Get("Content-Length") != strconv.Itoa(len(data)) {
		t.Fatalf("head: %d %v", w.Code, w.Header())
	}
	w := serve(http.MethodGet, "bytes=1000-1999")
	if w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), data[1000:2000]) ||
		w.Header().Get("Content-Range") != "bytes 1000-1999/"+strconv.Itoa(len(data)) {
		t.Fatalf("range: %d %v, %d bytes", w.Code, w.Header(), w.Body.Len())
	}
	if w := serve(http.MethodGet, "bytes=-100"); w.Code != http.StatusPartialContent || !bytes.Equal(w.Body.Bytes(), data[len(data)-100:]) {
		t.Fatalf("suffix range: %d, %d bytes", w.Code, w.Body.Len())
	}
	w = serve(http.MethodGet, "bytes=0-9,5000-5009")
	_, params, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	if w.Code != http.StatusPartialContent || err != nil {
		t.Fatalf("multi-range: %d %v", w.Code, err)
	}
	mr := multipart.NewReader(w.Body, params["boundary"])
	for _, want := range [][]byte{data[0:10], data[5000:5010]} {
		p, err := mr.NextPart()
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := io.ReadAll(p); !bytes.Equal(got, want) {
			t.Fatalf("multi-range part %s: %d bytes differ", p.Header.Get("Content-Range"), len(got))
		}
	}
	if w := serve(http.MethodGet, "bytes="+strconv.Itoa(len(data))+"-"); w.Code != http.StatusRequestedRangeNotSatisfiable {
		t.Fatalf("range past the end: %d", w.Code)
	}
}
