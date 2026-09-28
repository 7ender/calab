// Package blob stores file bytes behind a driver-neutral interface (ADR-0011).
// Metadata (name, mime, size, sha256) lives in Postgres (`files`); a Store only holds
// bytes under opaque keys. Key layout: "<workspace_id>/<file_id>" and
// "<workspace_id>/<file_id>.thumb" (see FileKey / ThumbKey).
package blob

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrNotFound is returned when a key does not exist.
var ErrNotFound = errors.New("blob: not found")

// ErrSizeMismatch is returned by Put when the reader yields a different number of bytes
// than declared. Nothing is stored in that case.
var ErrSizeMismatch = errors.New("blob: size mismatch")

// ErrInvalidKey is returned for keys outside the allowed charset / layout.
var ErrInvalidKey = errors.New("blob: invalid key")

// Meta describes a stored object.
type Meta struct {
	Size    int64
	ModTime time.Time
	// ContentType is what Put received; drivers without object metadata (fs) return "".
	// Callers serve files.mime from Postgres, not this field.
	ContentType string
}

// ReadSeekCloser is what Get returns; Seek enables Range requests (http.ServeContent).
type ReadSeekCloser interface {
	io.ReadSeeker
	io.Closer
}

// Store is a blob storage driver.
type Store interface {
	// Put stores r under key atomically: readers never observe a partial object, and an
	// existing object is replaced only after the new one is fully written. size < 0 means
	// unknown; otherwise the byte count is verified (ErrSizeMismatch).
	Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error
	// Get opens key for reading; ErrNotFound if absent. The caller closes the reader.
	Get(ctx context.Context, key string) (ReadSeekCloser, Meta, error)
	// Stat returns metadata; ErrNotFound if absent.
	Stat(ctx context.Context, key string) (Meta, error)
	// Delete removes key; deleting a missing key is not an error.
	Delete(ctx context.Context, key string) error
}

// FileKey is the key of a file's bytes.
func FileKey(workspaceID, fileID uuid.UUID) string {
	return workspaceID.String() + "/" + fileID.String()
}

// ThumbKey is the key of an image file's thumbnail.
func ThumbKey(workspaceID, fileID uuid.UUID) string {
	return FileKey(workspaceID, fileID) + ".thumb"
}

// LargeThumbKey is the key of the lazily made 1024 px thumbnail of the file stored under
// fileKey (the 512 px one made at upload keeps its ThumbKey).
func LargeThumbKey(fileKey string) string {
	return fileKey + ".thumb1024"
}

// DeleteThumbs removes a file's thumbnails, best effort. The large one exists only for files
// that have a thumbnail (thumbKey != nil).
func DeleteThumbs(ctx context.Context, s Store, fileKey string, thumbKey *string) {
	if thumbKey == nil {
		return
	}
	_ = s.Delete(ctx, *thumbKey)
	_ = s.Delete(ctx, LargeThumbKey(fileKey))
}

// ValidateKey accepts "/"-separated segments of [A-Za-z0-9._-], without empty, "." or ".."
// segments, at most 256 bytes. This keeps keys portable across fs and S3 and rules out
// path traversal in the fs driver.
func ValidateKey(key string) error {
	if key == "" || len(key) > 256 {
		return fmt.Errorf("%w: %q", ErrInvalidKey, key)
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") {
			return fmt.Errorf("%w: %q", ErrInvalidKey, key)
		}
		for i := 0; i < len(seg); i++ {
			if !keyChar(seg[i]) {
				return fmt.Errorf("%w: %q", ErrInvalidKey, key)
			}
		}
	}
	return nil
}

func keyChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return c == '.' || c == '_' || c == '-'
}
