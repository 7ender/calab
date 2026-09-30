// Package blobtest is an in-memory blob.Store for tests of code above the drivers: keys are
// validated like the drivers do, missing keys answer blob.ErrNotFound, and the whole store can
// be made to fail like an unreachable bucket.
package blobtest

import (
	"bytes"
	"context"
	"io"
	"sync"
	"time"

	"github.com/calaba/calaba/server/internal/blob"
)

// Store is an in-memory blob.Store; the zero value is not usable, see New.
type Store struct {
	mu      sync.Mutex
	objects map[string]object
	err     error
}

type object struct {
	data  []byte
	ctype string
	mod   time.Time
}

// New returns an empty store.
func New() *Store { return &Store{objects: map[string]object{}} }

var _ blob.Store = (*Store)(nil)

// Fail makes every call fail with err until Fail(nil).
func (s *Store) Fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.err = err
}

// Set stores data under key, as a writer past the store would (an egress upload).
func (s *Store) Set(key string, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = object{data: bytes.Clone(data), mod: time.Now()}
}

// Has reports whether key is stored.
func (s *Store) Has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.objects[key]
	return ok
}

// Len is the number of stored objects.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.objects)
}

func (s *Store) check(key string) error {
	if err := blob.ValidateKey(key); err != nil {
		return err
	}
	return s.err
}

// Put implements blob.Store.
func (s *Store) Put(ctx context.Context, key string, r io.Reader, size int64, contentType string) error {
	s.mu.Lock()
	err := s.check(key)
	s.mu.Unlock()
	if err != nil {
		return err
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if size >= 0 && int64(len(data)) != size {
		return blob.ErrSizeMismatch
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.objects[key] = object{data: data, ctype: contentType, mod: time.Now()}
	return nil
}

func (s *Store) get(key string) (object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(key); err != nil {
		return object{}, err
	}
	o, ok := s.objects[key]
	if !ok {
		return object{}, blob.ErrNotFound
	}
	return o, nil
}

// Get implements blob.Store.
func (s *Store) Get(_ context.Context, key string) (blob.ReadSeekCloser, blob.Meta, error) {
	o, err := s.get(key)
	if err != nil {
		return nil, blob.Meta{}, err
	}
	return reader{bytes.NewReader(o.data)}, meta(o), nil
}

// Stat implements blob.Store.
func (s *Store) Stat(_ context.Context, key string) (blob.Meta, error) {
	o, err := s.get(key)
	if err != nil {
		return blob.Meta{}, err
	}
	return meta(o), nil
}

// Delete implements blob.Store.
func (s *Store) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(key); err != nil {
		return err
	}
	delete(s.objects, key)
	return nil
}

func meta(o object) blob.Meta {
	return blob.Meta{Size: int64(len(o.data)), ModTime: o.mod, ContentType: o.ctype}
}

type reader struct{ *bytes.Reader }

func (reader) Close() error { return nil }
