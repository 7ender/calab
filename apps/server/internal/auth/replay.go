package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// Idempotent refresh (docs/09 #89): a client whose refresh answer was lost (network cut
// mid-response, the app quitting for an update) retries with the token it still holds — the
// one the server has just rotated away. Within refreshGrace, and while the new token has not
// been used yet, that retry gets the same new refresh token again (plus a fresh access token)
// instead of an error that ends the session.
//
// The server keeps only hashes of refresh secrets, so the new secret is kept for the window
// in Valkey, sealed with a key derived from the *previous* secret: only a holder of the
// previous token can open it, and a Valkey dump alone yields nothing usable. The key is an
// HMAC, not the sha256 stored in Postgres, so a database leak does not open it either.

const replayKeyInfo = "calaba/refresh-replay/v1"

// replayBudget bounds the Valkey round-trips of the replay entry; a slow Valkey only costs
// the idempotency (the retry falls back to 409), never the refresh itself.
const replayBudget = time.Second

func replayRedisKey(sid uuid.UUID) string { return redisx.Key("auth:refresh_replay:" + sid.String()) }

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

// storeReplay remembers the rotation prevSecret → newSecret for refreshGrace. Called inside
// the rotating transaction (the session row is locked), so a retry that arrives right after
// the commit already finds the entry. Failure is logged, not returned.
func (s *Service) storeReplay(ctx context.Context, sid uuid.UUID, prevSecret, newSecret string) {
	blob, err := sealReplay(sid, prevSecret, newSecret)
	if err != nil {
		slog.WarnContext(ctx, "seal refresh replay failed", "session_id", sid, "err", err)
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), replayBudget)
	defer cancel()
	cmd := s.redis.B().Set().Key(replayRedisKey(sid)).Value(string(blob)).Px(refreshGrace).Build()
	if err := s.redis.Do(rctx, cmd).Error(); err != nil {
		// A lost answer within the window then gets 409 instead of the same token pair.
		slog.WarnContext(ctx, "store refresh replay failed", "session_id", sid, "err", err)
	}
}

// loadReplay returns the new secret the previous one was rotated to, if it is still the
// session's current secret (currentHash): a new token that was used already is never handed
// out again. ok=false → no entry, wrong token, or Valkey unavailable.
func (s *Service) loadReplay(ctx context.Context, sid uuid.UUID, prevSecret string, currentHash []byte) (string, bool) {
	rctx, cancel := context.WithTimeout(ctx, replayBudget)
	defer cancel()
	blob, err := s.redis.Do(rctx, s.redis.B().Get().Key(replayRedisKey(sid)).Build()).AsBytes()
	if err != nil {
		if !rueidis.IsRedisNil(err) {
			slog.WarnContext(ctx, "load refresh replay failed", "session_id", sid, "err", err)
		}
		return "", false
	}
	next, err := openReplay(sid, prevSecret, blob)
	if err != nil {
		return "", false
	}
	if subtle.ConstantTimeCompare(HashRefreshSecret(next), currentHash) != 1 {
		return "", false
	}
	return next, true
}
