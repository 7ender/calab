package blob

import (
	"context"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestFSContract(t *testing.T) {
	root := filepath.Join(t.TempDir(), "files")
	s, err := NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	testStoreContract(t, s)
	// Failed writes remove their temp files.
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(d.Name(), ".tmp-") {
			t.Errorf("temp file left behind: %s", path)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestKeyLayout(t *testing.T) {
	ws, id := uuid.New(), uuid.New()
	key := FileKey(ws, id)
	if key != ws.String()+"/"+id.String() || ThumbKey(ws, id) != key+".thumb" || LargeThumbKey(key) != key+".thumb1024" {
		t.Fatal("key layout")
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
	ctx := context.Background()
	if _, err := Open(ctx, Config{Driver: DriverFS, Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	// An incomplete s3 config fails before any network call.
	_, err := Open(ctx, Config{Driver: DriverS3, S3: S3Config{Endpoint: "https://s3.example.com", Region: "r"}})
	if err == nil || !strings.Contains(err.Error(), "STORAGE_S3_BUCKET") {
		t.Fatalf("incomplete s3 config: %v", err)
	}
	if _, err := Open(ctx, Config{Driver: "nope"}); err == nil {
		t.Fatal("unknown driver accepted")
	}
}
