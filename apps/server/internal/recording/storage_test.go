package recording

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/blob/blobtest"
	"github.com/calaba/calaba/server/internal/rtc"
)

var recordedAudio = bytes.Repeat([]byte("0123456789abcdef"), 1000) // 16000 bytes

// checkRead reads f both ways the service does: sequentially (the audio attachment) and in
// chunks at offsets (the upload to GPTunneL), the last chunk ending past the file.
func checkRead(t *testing.T, f recordFile, want []byte) {
	t.Helper()
	buf := make([]byte, 6000)
	for off := int64(0); off < int64(len(want)); off += int64(len(buf)) {
		n, err := f.ReadAt(buf, off)
		end := min(off+int64(len(buf)), int64(len(want)))
		short := end < off+int64(len(buf))
		if int64(n) != end-off || !bytes.Equal(buf[:n], want[off:end]) || (short && err != io.EOF) || (!short && err != nil && err != io.EOF) {
			t.Fatalf("ReadAt(%d): %d bytes, %v", off, n, err)
		}
	}
	got, err := io.ReadAll(f)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("read %d bytes, %v", len(got), err)
	}
}

// STORAGE_DRIVER=fs: the volume shared with the egress, as before the bucket existed.
func TestVolumeStore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	v := volume{dir: dir, egressDir: "/out/"}
	file := recordingFile(uuid.New(), uuid.New())

	out, err := v.output(file)
	if err != nil || out.Filepath != "/out/"+file || out.S3 != nil {
		t.Fatalf("output: %+v %v", out, err)
	}
	if st, err := os.Stat(filepath.Dir(v.path(file))); err != nil || st.Mode().Perm() != 0o777 {
		t.Fatalf("workspace directory for the egress: %v %v", st, err)
	}

	if _, err := v.stat(ctx, file); !errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnavailable) {
		t.Fatalf("stat before the egress wrote: %v", err)
	}
	if _, _, err := v.open(ctx, file); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("open before the egress wrote: %v", err)
	}
	if err := os.WriteFile(v.path(file), recordedAudio, 0o600); err != nil {
		t.Fatal(err)
	}
	if size, err := v.stat(ctx, file); err != nil || size != int64(len(recordedAudio)) {
		t.Fatalf("stat: %d %v", size, err)
	}
	f, size, err := v.open(ctx, file)
	if err != nil || size != int64(len(recordedAudio)) {
		t.Fatalf("open: %d %v", size, err)
	}
	checkRead(t, f, recordedAudio)
	_ = f.Close()

	if err := v.remove(ctx, file); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(v.path(file)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("removed file: %v", err)
	}
	if err := v.remove(ctx, file); err != nil {
		t.Fatalf("remove a missing file: %v", err)
	}

	// The sweep removes old .mp4 files only.
	old, fresh, other := v.path(recordingFile(uuid.New(), uuid.New())), v.path(recordingFile(uuid.New(), uuid.New())), filepath.Join(dir, "keep.json")
	for _, p := range []string{old, fresh, other} {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-48 * time.Hour)
	for _, p := range []string{old, other} {
		if err := os.Chtimes(p, past, past); err != nil {
			t.Fatal(err)
		}
	}
	v.sweep(ctx, time.Now().Add(-24*time.Hour))
	for p, want := range map[string]bool{old: false, fresh: true, other: true} {
		if _, err := os.Stat(p); (err == nil) != want {
			t.Fatalf("after the sweep %s exists = %v, want %v", p, err == nil, want)
		}
	}
}

// STORAGE_DRIVER=s3: the egress uploads into the files bucket, the service goes through the
// blob store with the same key.
func TestBucketStore(t *testing.T) {
	ctx := context.Background()
	mem := blobtest.New()
	b := Bucket{Store: mem, S3: blob.S3Config{
		Endpoint: "https://s3.example.test", Region: "region-1", Bucket: "files", AccessKeyID: "test-key-id",
		SecretAccessKey: "test-secret", KeyPrefix: "/calab/files/", ForcePathStyle: true,
	}}
	file := recordingFile(uuid.New(), uuid.New())

	out, err := b.output(file)
	want := rtc.FileOutput{Filepath: "calab/files/" + file, S3: &rtc.S3Upload{
		Endpoint: "https://s3.example.test", Region: "region-1", Bucket: "files", AccessKey: "test-key-id",
		Secret: "test-secret", ForcePathStyle: true,
	}}
	if err != nil || out.Filepath != want.Filepath || out.S3 == nil || *out.S3 != *want.S3 {
		t.Fatalf("output: %+v %v", out, err)
	}
	if out.Filepath != b.S3.ObjectKey(file) {
		t.Fatalf("the egress writes %q, the blob store reads %q", out.Filepath, b.S3.ObjectKey(file))
	}
	if _, err := b.output("../" + file); !errors.Is(err, blob.ErrInvalidKey) {
		t.Fatalf("output of a bad key: %v", err)
	}
	if mem.Len() != 0 {
		t.Fatal("output wrote into the bucket")
	}

	// Missing: not uploaded (yet), or the egress failed.
	if _, err := b.stat(ctx, file); !errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnavailable) {
		t.Fatalf("stat of a missing object: %v", err)
	}
	if _, _, err := b.open(ctx, file); !errors.Is(err, fs.ErrNotExist) || errors.Is(err, errUnavailable) {
		t.Fatalf("open of a missing object: %v", err)
	}

	// Happy path: the egress uploaded it.
	mem.Set(file, recordedAudio)
	if size, err := b.stat(ctx, file); err != nil || size != int64(len(recordedAudio)) {
		t.Fatalf("stat: %d %v", size, err)
	}
	f, size, err := b.open(ctx, file)
	if err != nil || size != int64(len(recordedAudio)) {
		t.Fatalf("open: %d %v", size, err)
	}
	checkRead(t, f, recordedAudio)
	_ = f.Close()

	// A bucket that does not answer decides nothing: errUnavailable, never "no file".
	down := errors.New("connection refused")
	mem.Fail(down)
	if _, err := b.stat(ctx, file); !errors.Is(err, errUnavailable) || errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stat, bucket down: %v", err)
	}
	if _, _, err := b.open(ctx, file); !errors.Is(err, errUnavailable) {
		t.Fatalf("open, bucket down: %v", err)
	}
	if err := b.remove(ctx, file); !errors.Is(err, errUnavailable) {
		t.Fatalf("remove, bucket down: %v", err)
	}
	mem.Fail(nil)

	// The sweep leaves the bucket alone (blob.Store cannot list).
	b.sweep(ctx, time.Now().Add(time.Hour))
	if !mem.Has(file) {
		t.Fatal("the sweep removed an object")
	}
	if err := b.remove(ctx, file); err != nil || mem.Has(file) {
		t.Fatalf("remove: %v", err)
	}
	if err := b.remove(ctx, file); err != nil {
		t.Fatalf("remove a missing object: %v", err)
	}
}

// New picks the bucket only when it is configured.
func TestServiceStore(t *testing.T) {
	if _, ok := New(Config{Dir: "/data/recordings", EgressDir: "/out"}, nil, nil, nil, nil, nil).store.(volume); !ok {
		t.Fatal("no bucket: the volume")
	}
	mem := blobtest.New()
	if b, ok := New(Config{Bucket: &Bucket{Store: mem}}, nil, nil, nil, nil, nil).store.(Bucket); !ok || b.Store != mem {
		t.Fatal("bucket")
	}
}
