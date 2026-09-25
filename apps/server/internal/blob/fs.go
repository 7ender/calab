package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// FS stores blobs as files under a root directory. Writes go to a temp file in the target
// directory, are fsynced and renamed into place (atomic on POSIX filesystems).
type FS struct {
	root string
}

// NewFS creates the root directory if needed and returns the driver.
func NewFS(root string) (*FS, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("blob fs: %w", err)
	}
	if err := os.MkdirAll(abs, 0o750); err != nil {
		return nil, fmt.Errorf("blob fs: create root: %w", err)
	}
	return &FS{root: abs}, nil
}

func (s *FS) path(key string) (string, error) {
	if err := ValidateKey(key); err != nil {
		return "", err
	}
	return filepath.Join(s.root, filepath.FromSlash(key)), nil
}

// ctxReader aborts a copy when ctx is cancelled (client went away mid-upload).
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// Put implements Store.
func (s *FS) Put(ctx context.Context, key string, r io.Reader, size int64, _ string) (err error) {
	dst, err := s.path(key)
	if err != nil {
		return err
	}
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("blob fs: mkdir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("blob fs: temp file: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
		}
	}()
	src := io.Reader(ctxReader{ctx, r})
	if size >= 0 {
		src = io.LimitReader(src, size+1) // one extra byte detects oversize input
	}
	n, err := io.Copy(tmp, src)
	if err != nil {
		return fmt.Errorf("blob fs: write: %w", err)
	}
	if size >= 0 && n != size {
		return ErrSizeMismatch
	}
	if err = tmp.Sync(); err != nil {
		return fmt.Errorf("blob fs: sync: %w", err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("blob fs: close: %w", err)
	}
	if err = os.Rename(tmp.Name(), dst); err != nil {
		return fmt.Errorf("blob fs: rename: %w", err)
	}
	// Persist the directory entry too, so the rename survives a crash.
	if d, derr := os.Open(dir); derr == nil { //nolint:gosec // dir is derived from a validated key
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

func meta(fi fs.FileInfo) Meta {
	return Meta{Size: fi.Size(), ModTime: fi.ModTime()}
}

// Get implements Store.
func (s *FS) Get(_ context.Context, key string) (ReadSeekCloser, Meta, error) {
	p, err := s.path(key)
	if err != nil {
		return nil, Meta{}, err
	}
	f, err := os.Open(p) //nolint:gosec // p is derived from a validated key under root
	if errors.Is(err, fs.ErrNotExist) {
		return nil, Meta{}, ErrNotFound
	}
	if err != nil {
		return nil, Meta{}, fmt.Errorf("blob fs: open: %w", err)
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, Meta{}, fmt.Errorf("blob fs: stat: %w", err)
	}
	return f, meta(fi), nil
}

// Stat implements Store.
func (s *FS) Stat(_ context.Context, key string) (Meta, error) {
	p, err := s.path(key)
	if err != nil {
		return Meta{}, err
	}
	fi, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return Meta{}, ErrNotFound
	}
	if err != nil {
		return Meta{}, fmt.Errorf("blob fs: stat: %w", err)
	}
	return meta(fi), nil
}

// Delete implements Store.
func (s *FS) Delete(_ context.Context, key string) error {
	p, err := s.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("blob fs: delete: %w", err)
	}
	return nil
}
