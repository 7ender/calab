package recording

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/rtc"
)

// Where the file of a recording lives. rec.File is "<workspace>/<recording>.mp4" either way.
//
//   - volume (STORAGE_DRIVER=fs, the compose default): the egress writes the file into the
//     recordings volume it shares with the API; the API reads and deletes it there.
//   - bucket (STORAGE_DRIVER=s3): the API and the egress need not share a disk (API in
//     Kubernetes, egress on a media host). The egress uploads the finished file into the files
//     bucket under the blob key rec.File, and the API reads, checks and deletes it through the
//     blob store, like any file.

// errUnavailable: the bucket did not answer (network, credentials, the store is down). The
// file may well be there, so nothing is decided about it: the caller tries again later. The
// volume never reports it.
var errUnavailable = errors.New("recording: file storage unavailable")

// recordFile is an open recording: sequential reads (the audio attachment) and reads at an
// offset (the resumable upload to GPTunneL).
type recordFile interface {
	io.Reader
	io.ReaderAt
	io.Closer
}

type recordStore interface {
	// output prepares the place of file and says where the egress puts it.
	output(file string) (rtc.FileOutput, error)
	// stat returns the size of file: an error wrapping fs.ErrNotExist when there is none, 0
	// when it is not a regular file.
	stat(ctx context.Context, file string) (int64, error)
	// open opens file for reading with its size (0: not a regular file / unknown); an error
	// wrapping fs.ErrNotExist when there is none.
	open(ctx context.Context, file string) (recordFile, int64, error)
	// remove deletes file; a missing one is not an error.
	remove(ctx context.Context, file string) error
	// sweep removes stray recordings (without a row that would remove them) older than before.
	sweep(ctx context.Context, before time.Time)
}

// ---- volume ----

type volume struct {
	dir       string // RECORDINGS_PATH: the volume as the API sees it
	egressDir string // RECORDING_EGRESS_DIR: the same volume in the egress container
}

func (v volume) path(file string) string {
	return filepath.Join(v.dir, filepath.FromSlash(file))
}

// output: the egress writes into the workspace directory. It runs as another user, so the
// directory is made writable for it (the volume holds nothing else).
func (v volume) output(file string) (rtc.FileOutput, error) {
	dir := filepath.Dir(v.path(file))
	if err := os.MkdirAll(dir, 0o777); err != nil { //nolint:gosec // G301: shared with the egress container
		return rtc.FileOutput{}, fmt.Errorf("recording: create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o777); err != nil { //nolint:gosec // G302: see above
		return rtc.FileOutput{}, fmt.Errorf("recording: chmod %s: %w", dir, err)
	}
	return rtc.FileOutput{Filepath: strings.TrimRight(v.egressDir, "/") + "/" + file}, nil
}

func (v volume) stat(_ context.Context, file string) (int64, error) {
	st, err := os.Stat(v.path(file)) //nolint:gosec // G703: file is recordingFile() from the database, not user input
	if err != nil {
		return 0, err
	}
	if !st.Mode().IsRegular() {
		return 0, nil
	}
	return st.Size(), nil
}

func (v volume) open(_ context.Context, file string) (recordFile, int64, error) {
	f, err := os.Open(v.path(file))
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		return f, 0, nil
	}
	return f, st.Size(), nil
}

func (v volume) remove(_ context.Context, file string) error {
	if err := os.Remove(v.path(file)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// sweep removes any .mp4 on the volume older than before: files of rows that are gone, or of
// an egress whose start was never stored.
func (v volume) sweep(ctx context.Context, before time.Time) {
	root, err := os.OpenRoot(v.dir) // no symlink escapes out of the volume
	if err != nil {
		return
	}
	defer func() { _ = root.Close() }()
	_ = fs.WalkDir(root.FS(), ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".mp4") {
			return nil //nolint:nilerr // best effort
		}
		if info, err := d.Info(); err == nil && info.ModTime().Before(before) {
			if err := root.Remove(path); err == nil {
				slog.InfoContext(ctx, "recording: removed a stray file", "path", path)
			}
		}
		return nil
	})
}

// ---- bucket ----

// Bucket is the files bucket as the recordings use it (STORAGE_DRIVER=s3).
type Bucket struct {
	Store blob.Store    // the s3 blob store of the files (STORAGE_S3_*)
	S3    blob.S3Config // the same bucket, handed to the egress to upload into
}

func (b Bucket) output(file string) (rtc.FileOutput, error) {
	if err := blob.ValidateKey(file); err != nil {
		return rtc.FileOutput{}, err
	}
	return rtc.FileOutput{Filepath: b.S3.ObjectKey(file), S3: &rtc.S3Upload{
		Endpoint: b.S3.Endpoint, Region: b.S3.Region, Bucket: b.S3.Bucket,
		AccessKey: b.S3.AccessKeyID, Secret: b.S3.SecretAccessKey, ForcePathStyle: b.S3.ForcePathStyle,
	}}, nil
}

// storeErr maps an error of the blob store: a missing object is fs.ErrNotExist (as on the
// volume), anything else errUnavailable.
func storeErr(err error) error {
	if errors.Is(err, blob.ErrNotFound) {
		return fmt.Errorf("recording: %w", fs.ErrNotExist)
	}
	return fmt.Errorf("%w: %w", errUnavailable, err)
}

func (b Bucket) stat(ctx context.Context, file string) (int64, error) {
	m, err := b.Store.Stat(ctx, file)
	if err != nil {
		return 0, storeErr(err)
	}
	return m.Size, nil
}

func (b Bucket) open(ctx context.Context, file string) (recordFile, int64, error) {
	r, m, err := b.Store.Get(ctx, file)
	if err != nil {
		return nil, 0, storeErr(err)
	}
	return &bucketFile{ReadSeekCloser: r, ctx: ctx, store: b.Store, key: file}, m.Size, nil
}

func (b Bucket) remove(ctx context.Context, file string) error {
	if err := b.Store.Delete(ctx, file); err != nil {
		return storeErr(err)
	}
	return nil
}

// sweep: the bucket is not swept. blob.Store cannot list, and listing the whole files bucket
// for ".mp4" keys every hour would cost more than it saves. Every recording has its row before
// the egress starts, and the janitor removes the object by the database, as it does on the
// volume; only a row that goes away with its workspace before that leaves the object behind
// (docs/12).
func (Bucket) sweep(context.Context, time.Time) {}

// bucketFile reads sequentially through the store's reader, and at an offset with a request of
// its own: the upload to GPTunneL reads 8 MB chunks with retries in between, a download held
// open that long may be cut by the store.
type bucketFile struct {
	blob.ReadSeekCloser
	ctx   context.Context
	store blob.Store
	key   string
}

func (f *bucketFile) ReadAt(p []byte, off int64) (int, error) {
	r, _, err := f.store.Get(f.ctx, f.key)
	if err != nil {
		return 0, storeErr(err)
	}
	defer func() { _ = r.Close() }()
	if _, err := r.Seek(off, io.SeekStart); err != nil {
		return 0, err
	}
	n, err := io.ReadFull(r, p)
	if errors.Is(err, io.ErrUnexpectedEOF) {
		err = io.EOF // the object ends inside p
	}
	return n, err
}
