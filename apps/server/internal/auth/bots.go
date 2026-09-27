package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Bot tokens (ADR-0031): "calab_bot_<bot user id>_<secret>", secret = 32 random bytes
// (base64url, 43 characters). The fixed prefix lets secret scanners recognise leaked tokens;
// the bot id makes the lookup O(1). Only sha256(secret) is stored (bots.token_hash): the
// secret is high-entropy, so a fast hash is enough. Every request checks the hash against
// the current token; the check is cached in Valkey for BotAuthCacheTTL and the cache is
// dropped when the token changes, so a revoked token stops working at once.
const (
	BotTokenPrefix = "calab_bot_" //nolint:gosec // G101: the public prefix of bot tokens, not a credential
	// BotAuthCacheTTL bounds how long a token check is cached (ADR-0031: ≤ 30 s).
	BotAuthCacheTTL = 30 * time.Second
	// botPrefixLen: characters of the secret kept as bots.token_prefix (display only).
	botPrefixLen = 6
	botSecretLen = 43
)

// ErrBotNotAllowed is returned when a bot calls a route that is for people only (ADR-0031).
var ErrBotNotAllowed = httpx.Forbidden("not available for bots").WithDetails("BOT_NOT_ALLOWED", 0, 0)

// ErrBotsOnly is returned when a person calls a /api/bots/me route.
var ErrBotsOnly = httpx.Forbidden("only bots may use this endpoint")

// ErrSessionRevoked means the access token's session (or the bot's token) was revoked.
var ErrSessionRevoked = errors.New("auth: session revoked")

// IsBotToken reports whether a bearer token has the bot token form (not whether it is valid).
func IsBotToken(tok string) bool { return strings.HasPrefix(tok, BotTokenPrefix) }

// IsBotRequest reports whether the request carries a bot token (public routes that
// authenticate themselves refuse bots before anything else).
func IsBotRequest(r *http.Request) bool {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && IsBotToken(tok)
}

// NewBotToken returns a new token for bot id, its secret hash and the display prefix.
func NewBotToken(id uuid.UUID) (token string, hash []byte, prefix string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(b)
	return BotTokenPrefix + id.String() + "_" + secret, HashRefreshSecret(secret), secret[:botPrefixLen], nil
}

// ParseBotToken splits a bot token; ok=false if malformed.
func ParseBotToken(tok string) (id uuid.UUID, secret string, ok bool) {
	rest, found := strings.CutPrefix(tok, BotTokenPrefix)
	if !found || len(rest) != 36+1+botSecretLen || rest[36] != '_' {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(rest[:36])
	if err != nil {
		return uuid.Nil, "", false
	}
	secret = rest[37:]
	if b, err := base64.RawURLEncoding.DecodeString(secret); err != nil || len(b) != 32 {
		return uuid.Nil, "", false
	}
	return id, secret, true
}

func botAuthKey(id uuid.UUID) string { return "bot:auth:" + id.String() }

// botAuth is the cached current token of a bot: token id + sha256 of the secret, or none.
type botAuth struct {
	tokenID uuid.UUID
	hash    []byte
}

func (a botAuth) encode() string {
	if a.hash == nil {
		return "-"
	}
	return a.tokenID.String() + ":" + hex.EncodeToString(a.hash)
}

func decodeBotAuth(v string) (botAuth, bool) {
	if v == "-" {
		return botAuth{}, true
	}
	tid, h, ok := strings.Cut(v, ":")
	if !ok {
		return botAuth{}, false
	}
	id, err := uuid.Parse(tid)
	hash, err2 := hex.DecodeString(h)
	if err != nil || err2 != nil || len(hash) != sha256.Size {
		return botAuth{}, false
	}
	return botAuth{tokenID: id, hash: hash}, true
}

// loadBotAuth returns the bot's current token (from the Valkey cache, else Postgres).
func (s *Service) loadBotAuth(ctx context.Context, id uuid.UUID) (botAuth, error) {
	v, err := s.redis.DoCache(ctx, s.redis.B().Get().Key(botAuthKey(id)).Cache(), BotAuthCacheTTL).ToString()
	if err == nil {
		if a, ok := decodeBotAuth(v); ok {
			return a, nil
		}
	} else if !rueidis.IsRedisNil(err) {
		return botAuth{}, err
	}
	a, err := s.readBotAuth(ctx, id)
	if err != nil {
		return botAuth{}, err
	}
	// NX: a token change writes the new value itself (BotTokenChanged); a request that read
	// Postgres before the change must not put the old value back.
	_ = s.redis.Do(ctx, s.redis.B().Set().Key(botAuthKey(id)).Value(a.encode()).Nx().Ex(BotAuthCacheTTL).Build()).Error()
	return a, nil
}

// readBotAuth reads the bot's current token from Postgres; none for an unknown, deleted,
// disabled or revoked bot.
func (s *Service) readBotAuth(ctx context.Context, id uuid.UUID) (botAuth, error) {
	row, err := s.db.Q.GetBotAuth(ctx, id)
	switch {
	case db.IsNotFound(err):
		return botAuth{}, nil
	case err != nil:
		return botAuth{}, err
	case row.TokenID == nil:
		return botAuth{}, nil
	}
	return botAuth{tokenID: *row.TokenID, hash: row.TokenHash}, nil
}

// authenticateBot checks a bot token against the bot's current token.
func (s *Service) authenticateBot(ctx context.Context, tok string) (Identity, error) {
	id, secret, ok := ParseBotToken(tok)
	if !ok {
		return Identity{}, ErrInvalidToken
	}
	a, err := s.loadBotAuth(ctx, id)
	if err != nil {
		return Identity{}, err
	}
	if a.hash == nil || subtle.ConstantTimeCompare(HashRefreshSecret(secret), a.hash) != 1 {
		return Identity{}, ErrInvalidToken
	}
	// The token id is revoked the moment the token is replaced; the marker also covers an
	// instance whose cache has not seen the change yet.
	revoked, err := s.IsRevoked(ctx, a.tokenID)
	if err != nil {
		return Identity{}, err
	}
	if revoked {
		return Identity{}, ErrSessionRevoked
	}
	return Identity{UserID: id, SessionID: a.tokenID, IsBot: true}, nil
}

// BotTokenChanged makes a replaced / revoked bot token invalid everywhere at once, after the
// change is committed: the cached check is overwritten with the current token from Postgres,
// and the old token id is marked revoked (live requests are refused, the gateway socket is
// closed with 4010, LiveKit participants of that "session" are removed). oldTokenID may be
// nil (the bot had no token).
func (s *Service) BotTokenChanged(ctx context.Context, botID uuid.UUID, oldTokenID *uuid.UUID) {
	ctx = context.WithoutCancel(ctx)
	dctx, cancel := context.WithTimeout(ctx, revokeBudget)
	a, err := s.readBotAuth(dctx, botID)
	if err == nil {
		err = s.redis.Do(dctx, s.redis.B().Set().Key(botAuthKey(botID)).Value(a.encode()).Ex(BotAuthCacheTTL).Build()).Error()
	}
	if err != nil {
		// The revocation marker below still refuses the old token; a new one may be refused
		// until the cached entry expires (≤ BotAuthCacheTTL).
		_ = s.redis.Do(dctx, s.redis.B().Del().Key(botAuthKey(botID)).Build()).Error()
		slog.WarnContext(ctx, "bot token cache update failed", "bot_id", botID, "err", err)
	}
	cancel()
	if oldTokenID != nil {
		s.afterRevoke(ctx, *oldTokenID)
	}
}

// NoBots refuses bot identities (403 BOT_NOT_ALLOWED). It must run inside Require.
func NoBots(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id, ok := FromContext(r.Context()); ok && id.IsBot {
			httpx.WriteError(w, r, ErrBotNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// BotsOnly returns 403 unless the request is made by a bot.
func BotsOnly(ctx context.Context) error {
	if id, ok := FromContext(ctx); ok && id.IsBot {
		return nil
	}
	return ErrBotsOnly
}
