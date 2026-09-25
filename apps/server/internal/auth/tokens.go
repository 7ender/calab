package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const issuer = "calaba"

// Claims of the access JWT: sub = user id, sid = session id.
type Claims struct {
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

// Tokens issues and verifies access JWTs (HS256).
type Tokens struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time
}

// NewTokens creates an issuer. secret must be ≥ 32 bytes (validated in config).
func NewTokens(secret []byte, ttl time.Duration) *Tokens {
	return &Tokens{secret: secret, ttl: ttl, now: time.Now}
}

// Issue returns a signed access token and its expiry.
func (t *Tokens) Issue(userID, sessionID uuid.UUID) (string, time.Time, error) {
	now := t.now()
	exp := now.Add(t.ttl)
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		SessionID: sessionID.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    issuer,
			Subject:   userID.String(),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	})
	s, err := tok.SignedString(t.secret)
	return s, exp, err
}

// Identity is the authenticated principal of a request.
type Identity struct {
	UserID    uuid.UUID
	SessionID uuid.UUID
}

// ErrInvalidToken covers every access-token failure (bad signature, expired, malformed).
var ErrInvalidToken = errors.New("auth: invalid access token")

// Parse verifies an access token and returns its identity.
func (t *Tokens) Parse(token string) (Identity, error) {
	var c Claims
	_, err := jwt.ParseWithClaims(token, &c, func(*jwt.Token) (any, error) { return t.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(issuer),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
		jwt.WithTimeFunc(t.now),
	)
	if err != nil {
		return Identity{}, ErrInvalidToken
	}
	uid, err1 := uuid.Parse(c.Subject)
	sid, err2 := uuid.Parse(c.SessionID)
	if err1 != nil || err2 != nil {
		return Identity{}, ErrInvalidToken
	}
	return Identity{UserID: uid, SessionID: sid}, nil
}

// Refresh tokens are "<session_id>.<secret>", secret = 32 random bytes (base64url).
// Only sha256(secret) is stored. Binding the session id into the token makes reuse
// detection O(1): a well-formed token for a live session whose secret is not the current
// one is a replay of a rotated token (or a forgery), and the session is revoked.

// NewRefreshSecret returns a fresh secret and its hash.
func NewRefreshSecret() (secret string, hash []byte, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	secret = base64.RawURLEncoding.EncodeToString(b)
	return secret, HashRefreshSecret(secret), nil
}

// HashRefreshSecret hashes the secret part of a refresh token.
func HashRefreshSecret(secret string) []byte {
	h := sha256.Sum256([]byte(secret))
	return h[:]
}

// FormatRefreshToken joins the session id and the secret.
func FormatRefreshToken(sessionID uuid.UUID, secret string) string {
	return sessionID.String() + "." + secret
}

// ParseRefreshToken splits a refresh token; ok=false if malformed.
func ParseRefreshToken(tok string) (sessionID uuid.UUID, secret string, ok bool) {
	sid, sec, found := strings.Cut(tok, ".")
	if !found || len(sec) != 43 { // 32 bytes base64url without padding
		return uuid.Nil, "", false
	}
	if _, err := base64.RawURLEncoding.DecodeString(sec); err != nil {
		return uuid.Nil, "", false
	}
	id, err := uuid.Parse(sid)
	if err != nil {
		return uuid.Nil, "", false
	}
	return id, sec, true
}
