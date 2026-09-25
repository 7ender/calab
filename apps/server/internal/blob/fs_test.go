package blob

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestFSRoundTrip(t *testing.T) {
	ctx := context.Background()
	s, err := NewFS(filepath.Join(t.TempDir(), "files"))
	if err != nil {
		t.Fatal(err)
	}
	ws, id := uuid.New(), uuid.New()
	key := FileKey(ws, id)
	if ThumbKey(ws, id) != key+".thumb" {
		t.Fatal("thumb key layout")
	}
	data := []byte("hello, calaba")
	if err := s.Put(ctx, key, bytes.NewReader(data), int64(len(data)), "text/plain"); err != nil {
		t.Fatal(err)
	}
	m, err := s.Stat(ctx, key)
	if err != nil || m.Size != int64(len(data)) {
		t.Fatalf("stat: %+v %v", m, err)
	}
	r, m, err := s.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Seek(7, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	rest, _ := io.ReadAll(r)
	_ = r.Close()
	if string(rest) != "calaba" || m.Size != int64(len(data)) {
		t.Fatalf("got %q", rest)
	}
	// Overwrite with unknown size.
	if err := s.Put(ctx, key, strings.NewReader("v2"), -1, ""); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.Stat(ctx, key); m.Size != 2 {
		t.Fatalf("overwrite size %d", m.Size)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, key); err != nil {
		t.Fatalf("second delete: %v", err)
	}
	if _, _, err := s.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: %v", err)
	}
	if _, err := s.Stat(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stat after delete: %v", err)
	}
}

func TestFSSizeMismatchLeavesNothing(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	s, _ := NewFS(root)
	key := FileKey(uuid.New(), uuid.New())
	for _, n := range []int64{3, 100} { // declared smaller and larger than actual
		if err := s.Put(ctx, key, strings.NewReader("hello"), n, ""); !errors.Is(err, ErrSizeMismatch) {
			t.Fatalf("declared %d: %v", n, err)
		}
	}
	if _, err := s.Stat(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatal("partial object visible")
	}
	entries, _ := os.ReadDir(filepath.Dir(filepath.Join(root, filepath.FromSlash(key))))
	if len(entries) != 0 {
		t.Fatalf("temp files left behind: %v", entries)
	}
}

func TestFSCancelledContext(t *testing.T) {
	s, _ := NewFS(t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	key := FileKey(uuid.New(), uuid.New())
	if err := s.Put(ctx, key, strings.NewReader("x"), 1, ""); err == nil {
		t.Fatal("put with cancelled ctx succeeded")
	}
	if _, err := s.Stat(context.Background(), key); !errors.Is(err, ErrNotFound) {
		t.Fatal("object stored despite cancellation")
	}
}

func TestValidateKey(t *testing.T) {
	good := []string{"a", "a/b", FileKey(uuid.New(), uuid.New()), "x/y.thumb", "A_b-c.1"}
	bad := []string{"", "/a", "a/", "a//b", "../a", "a/../b", "a/./b", ".hidden", "a/.tmp-1", "a\\b", "a b", "é",
		strings.Repeat("a", 257)}
	for _, k := range good {
		if err := ValidateKey(k); err != nil {
			t.Errorf("%q rejected", k)
		}
	}
	for _, k := range bad {
		if err := ValidateKey(k); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("%q accepted", k)
		}
	}
	s, _ := NewFS(t.TempDir())
	if err := s.Put(context.Background(), "../escape", strings.NewReader("x"), 1, ""); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("traversal: %v", err)
	}
}

func TestOpen(t *testing.T) {
	if _, err := Open(DriverFS, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(DriverS3, ""); err == nil {
		t.Fatal("s3 should not be available yet")
	}
	if _, err := Open("nope", ""); err == nil {
		t.Fatal("unknown driver accepted")
	}
}
