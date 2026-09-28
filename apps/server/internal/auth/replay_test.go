package auth

import (
	"bytes"
	"errors"
	"testing"

	"github.com/google/uuid"
)

// The replay entry opens only with the previous secret and the same session id, never
// leaks the new secret in clear, and uses a fresh nonce per seal (docs/09 #89).
func TestReplaySealOpen(t *testing.T) {
	prev, _, err := NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	next, nextHash, err := NewRefreshSecret()
	if err != nil {
		t.Fatal(err)
	}
	sid := uuid.New()
	blob, err := sealReplay(sid, prev, next)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte(next)) || bytes.Contains(blob, nextHash) {
		t.Fatal("sealed entry contains the new secret or its hash")
	}
	got, err := openReplay(sid, prev, blob)
	if err != nil || got != next {
		t.Fatalf("open: %q %v", got, err)
	}
	// Wrong key: the new secret itself, another secret, the stored sha256 of prev.
	other, _, _ := NewRefreshSecret()
	for _, k := range []string{next, other, string(HashRefreshSecret(prev))} {
		if _, err := openReplay(sid, k, blob); !errors.Is(err, errReplayOpen) {
			t.Fatalf("opened with a wrong key: %v", err)
		}
	}
	// Bound to the session id.
	if _, err := openReplay(uuid.New(), prev, blob); !errors.Is(err, errReplayOpen) {
		t.Fatalf("opened under another session: %v", err)
	}
	// Tampered / truncated.
	bad := bytes.Clone(blob)
	bad[len(bad)-1] ^= 1
	if _, err := openReplay(sid, prev, bad); !errors.Is(err, errReplayOpen) {
		t.Fatalf("tampered entry opened: %v", err)
	}
	if _, err := openReplay(sid, prev, blob[:10]); !errors.Is(err, errReplayOpen) {
		t.Fatalf("truncated entry opened: %v", err)
	}
	// Fresh nonce per seal.
	blob2, err := sealReplay(sid, prev, next)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(blob[:12], blob2[:12]) {
		t.Fatal("nonce reused")
	}
}
