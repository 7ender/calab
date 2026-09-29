package auth

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// The previous token replays the same new secret only while the new generation is unused
// and the seal matches the current hash (docs/09 #123). No time limit.
func TestReplayPrevious(t *testing.T) {
	prev, _, _ := NewRefreshSecret()
	next, nextHash, _ := NewRefreshSecret()
	sid := uuid.New()
	seal, err := sealReplay(sid, prev, next)
	if err != nil {
		t.Fatal(err)
	}
	long := time.Now().Add(-48 * time.Hour)
	sess := sqlc.Session{ID: sid, RefreshTokenHash: nextHash, PrevRefreshTokenHash: HashRefreshSecret(prev), ReplaySeal: seal, RotatedAt: &long}
	if o, got := replayPrevious(sess, prev); o != replaySamePair || got != next {
		t.Fatalf("unused: %v %q", o, got)
	}
	used := sess
	now := time.Now()
	used.RefreshUsedAt = &now
	if o, _ := replayPrevious(used, prev); o != replayReuse {
		t.Fatalf("used: %v, want reuse", o)
	}
	legacy := sess
	legacy.ReplaySeal = nil
	if o, _ := replayPrevious(legacy, prev); o != replayConflict {
		t.Fatalf("no seal: %v, want conflict", o)
	}
	_, otherHash, _ := NewRefreshSecret()
	mismatch := sess
	mismatch.RefreshTokenHash = otherHash
	if o, _ := replayPrevious(mismatch, prev); o != replayConflict {
		t.Fatalf("seal of another generation: %v, want conflict", o)
	}
}

// Access tokens carry the refresh generation; the dedupe cache skips an already marked one.
func TestRefreshGenClaimAndUsedCache(t *testing.T) {
	tk := NewTokens([]byte("0123456789abcdef0123456789abcdef"), time.Minute)
	uid, sid := uuid.New(), uuid.New()
	tok, _, err := tk.Issue(uid, sid, 7)
	if err != nil {
		t.Fatal(err)
	}
	id, err := tk.Parse(tok)
	if err != nil || id.RefreshGen != 7 {
		t.Fatalf("parse: %+v %v", id, err)
	}
	var u usedGens
	if u.seen(sid, 7) {
		t.Fatal("seen before remember")
	}
	u.remember(sid, 7)
	if !u.seen(sid, 7) || !u.seen(sid, 6) || u.seen(sid, 8) {
		t.Fatal("seen: wrong generations")
	}
}

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
