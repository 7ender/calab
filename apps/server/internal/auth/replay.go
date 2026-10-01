package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Idempotent refresh (docs/04 «Auth», docs/09 #89, #123). A client whose refresh answer was
// lost (network cut mid-response, a stuck connection, the app quitting for an update) retries
// with the token it still holds — the one the server has just rotated away. For as long as
// the new token has not been used, that retry gets the same new refresh token again (plus a
// fresh access token) instead of an error that ends the session. There is no time limit: a
// laptop that was offline for hours comes back to the same pair.
//
// "Used" (sessions.refresh_used_at) = a refresh with the new token (that rotates it, so the
// old one becomes two generations old) or a request with an access token minted for the new
// generation (the access JWT carries it as claim "rg", markGenUsed). From then on the old
// token is reuse: the session is revoked with reason REUSE.
//
// The server keeps only hashes of refresh secrets, so the new secret is kept in the session
// row (replay_seal), sealed with a key derived from the *previous* secret: only a holder of
// the previous token can open it. The key is an HMAC, not the sha256 stored next to it, so a
// database dump alone opens nothing.

const replayKeyInfo = "calaba/refresh-replay/v1"

func replayAEAD(prevSecret string) (cipher.AEAD, error) {
	m := hmac.New(sha256.New, []byte(prevSecret))
	m.Write([]byte(replayKeyInfo))
	block, err := aes.NewCipher(m.Sum(nil))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealReplay encrypts newSecret under prevSecret, bound to the session id.
func sealReplay(sid uuid.UUID, prevSecret, newSecret string) ([]byte, error) {
	aead, err := replayAEAD(prevSecret)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize(), aead.NonceSize()+len(newSecret)+aead.Overhead())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(newSecret), sid[:]), nil
}

var errReplayOpen = errors.New("refresh replay entry does not open")

// openReplay is the inverse of sealReplay.
func openReplay(sid uuid.UUID, prevSecret string, blob []byte) (string, error) {
	aead, err := replayAEAD(prevSecret)
	if err != nil {
		return "", err
	}
	n := aead.NonceSize()
	if len(blob) < n+aead.Overhead() {
		return "", errReplayOpen
	}
	plain, err := aead.Open(nil, blob[:n], blob[n:], sid[:])
	if err != nil {
		return "", errReplayOpen
	}
	return string(plain), nil
}

// replayOutcome decides what presenting the previous refresh token of sess means.
type replayOutcome int

const (
	replayReuse    replayOutcome = iota // the new token was used: reuse → revoke
	replaySamePair                      // unused: hand out the same new token again
	replayConflict                      // unused, but no seal (rotated before migration 00040): 409, keep the session
)

// replayPrevious: the presented secret is the session's previous one (checked by the caller).
// Returns the new secret for replaySamePair.
func replayPrevious(sess sqlc.Session, prevSecret string) (replayOutcome, string) {
	if sess.RefreshUsedAt != nil {
		return replayReuse, ""
	}
	if sess.ReplaySeal == nil {
		return replayConflict, ""
	}
	next, err := openReplay(sess.ID, prevSecret, sess.ReplaySeal)
	if err != nil || !hmac.Equal(HashRefreshSecret(next), sess.RefreshTokenHash) {
		// Cannot happen for a row written by RotateSession; never hand out a mismatching token.
		return replayConflict, ""
	}
	return replaySamePair, next
}

// usedGens remembers, per API instance, the refresh generation already marked used for a
// session, so a busy client costs one UPDATE per rotation (~ every ACCESS_TOKEN_TTL), not one
// per request. Bounded: cleared when it grows past usedGensMax (the next requests re-mark,
// which the WHERE clause makes a no-op).
type usedGens struct {
	m sync.Map // session id → int64 generation
	n atomic.Int64
}

const usedGensMax = 100_000

// markBudget bounds the UPDATE; a slow database only delays reuse detection for this
// generation (the next request tries again), never the request.
const markBudget = time.Second

func (u *usedGens) seen(sid uuid.UUID, gen int64) bool {
	v, ok := u.m.Load(sid)
	return ok && v.(int64) >= gen
}

func (u *usedGens) remember(sid uuid.UUID, gen int64) {
	if u.n.Add(1) > usedGensMax {
		u.m.Clear()
		u.n.Store(0)
	}
	// Keep the highest generation: a late request with an older access token (whose UPDATE
	// was a no-op) must not make the current generation look unmarked again.
	for {
		v, loaded := u.m.LoadOrStore(sid, gen)
		if !loaded || v.(int64) >= gen || u.m.CompareAndSwap(sid, v, gen) {
			return
		}
	}
}

// markGenUsed records the first use of the access token's refresh generation: from now on
// the previous refresh token of the session is reuse. Tokens without a generation (issued
// before 00040) are ignored. Failures are logged; the request goes on.
func (s *Service) markGenUsed(ctx context.Context, id Identity) {
	if id.IsBot || id.RefreshGen <= 0 || s.used.seen(id.SessionID, id.RefreshGen) {
		return
	}
	mctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), markBudget)
	defer cancel()
	if err := db.GuardExec(mctx, s.db, func(guarded *sqlc.Queries) error {
		return guarded.MarkRefreshGenUsed(mctx, sqlc.MarkRefreshGenUsedParams{ID: id.SessionID, RefreshGen: id.RefreshGen})
	}); err != nil {
		slog.WarnContext(ctx, "mark refresh generation used failed", "session_id", id.SessionID, "err", err)
		return
	}
	s.used.remember(id.SessionID, id.RefreshGen)
}
