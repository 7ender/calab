package signing

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/url"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var (
	// ErrConfig identifies invalid operator key material without echoing it.
	ErrConfig = errors.New("signing: invalid RSA keyring configuration")
	// ErrClaims identifies rejected typed claims without disclosing their values.
	ErrClaims = errors.New("signing: invalid standard claims")
	// ErrToken identifies verification/signature failure without the raw token.
	ErrToken = errors.New("signing: invalid RS256 token")
)

// Key configures a unique kid and one PKCS#1/PKCS#8 private or PKCS#1/PKIX
// public PEM block. Certificates and encrypted/concatenated PEM are rejected.
type Key struct {
	KID string
	PEM []byte
}

// Config pins the issuer and an explicit active private key. Now is a trusted
// clock hook. Defaults: maximum lifetime 5 minutes, zero skew. Lifetime has a
// 5-minute ceiling and skew a 60-second ceiling; the application may narrow both.
type Config struct {
	Issuer      string
	ActiveKID   string
	Keys        []Key
	Now         func() time.Time
	MaxLifetime time.Duration
	ClockSkew   time.Duration
}

// Claims contains only standard claims and an explicit minimal profile subset.
// Audience is a single client identifier. No arbitrary claim map is accepted.
type Claims struct {
	Issuer            string
	Audience          string
	Subject           string
	IssuedAt          time.Time
	ExpiresAt         time.Time
	NotBefore         *time.Time
	Nonce             string
	AuthTime          *time.Time
	Name              string
	PreferredUsername string
	Email             string
	EmailVerified     *bool
}

type wireClaims struct {
	Issuer            string `json:"iss"`
	Audience          string `json:"aud"`
	Subject           string `json:"sub"`
	IssuedAt          int64  `json:"iat"`
	ExpiresAt         int64  `json:"exp"`
	NotBefore         *int64 `json:"nbf,omitempty"`
	Nonce             string `json:"nonce,omitempty"`
	AuthTime          *int64 `json:"auth_time,omitempty"`
	Name              string `json:"name,omitempty"`
	PreferredUsername string `json:"preferred_username,omitempty"`
	Email             string `json:"email,omitempty"`
	EmailVerified     *bool  `json:"email_verified,omitempty"`
}

func (w *wireClaims) GetIssuer() (string, error)  { return w.Issuer, nil }
func (w *wireClaims) GetSubject() (string, error) { return w.Subject, nil }
func (w *wireClaims) GetAudience() (jwt.ClaimStrings, error) {
	return jwt.ClaimStrings{w.Audience}, nil
}
func (w *wireClaims) GetIssuedAt() (*jwt.NumericDate, error)       { return numeric(w.IssuedAt), nil }
func (w *wireClaims) GetExpirationTime() (*jwt.NumericDate, error) { return numeric(w.ExpiresAt), nil }
func (w *wireClaims) GetNotBefore() (*jwt.NumericDate, error) {
	if w.NotBefore == nil {
		return nil, nil
	}
	return numeric(*w.NotBefore), nil
}

// JWK deliberately exposes only RSA public verification parameters.
type JWK struct {
	KTY string `json:"kty"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	KID string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS is sorted by kid and contains no private RSA parameters.
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// Keyring holds parsed keys privately and is safe for concurrent use. Rebuild
// with New for publish/activate/retire; it has no mutating key lifecycle methods.
type Keyring struct {
	issuer   string
	active   string
	private  *rsa.PrivateKey
	public   map[string]*rsa.PublicKey
	jwks     JWKS
	now      func() time.Time
	lifetime time.Duration
	skew     time.Duration
}

// String keeps accidental diagnostics from exposing key material.
func (*Keyring) String() string { return "signing.Keyring(redacted)" }

// GoString also redacts Go-syntax diagnostics.
func (*Keyring) GoString() string { return "signing.Keyring(redacted)" }

// New fails closed on malformed, weak, duplicate, or missing active keys.
func New(c Config) (*Keyring, error) {
	if !validIssuer(c.Issuer) || !identifier(c.ActiveKID) || len(c.Keys) == 0 || len(c.Keys) > 32 || c.MaxLifetime < 0 || c.MaxLifetime > 5*time.Minute || c.ClockSkew < 0 || c.ClockSkew > time.Minute {
		return nil, ErrConfig
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.MaxLifetime == 0 {
		c.MaxLifetime = 5 * time.Minute
	}
	r := &Keyring{issuer: c.Issuer, active: c.ActiveKID, public: make(map[string]*rsa.PublicKey), now: c.Now, lifetime: c.MaxLifetime, skew: c.ClockSkew}
	for _, k := range c.Keys {
		if !identifier(k.KID) {
			return nil, ErrConfig
		}
		if _, exists := r.public[k.KID]; exists {
			return nil, ErrConfig
		}
		priv, pub, err := parsePEM(k.PEM)
		if err != nil {
			return nil, ErrConfig
		}
		// A single RSA key cannot masquerade under multiple lifecycle kids.
		for _, existing := range r.public {
			if existing.N.Cmp(pub.N) == 0 && existing.E == pub.E {
				return nil, ErrConfig
			}
		}
		// Detach public keys from the parsed private struct so verify-only keys
		// do not keep configured private material reachable in this snapshot.
		pub = &rsa.PublicKey{N: new(big.Int).Set(pub.N), E: pub.E}
		r.public[k.KID] = pub
		if k.KID == c.ActiveKID {
			if priv == nil {
				return nil, ErrConfig
			}
			r.private = priv
		}
		r.jwks.Keys = append(r.jwks.Keys, JWK{KTY: "RSA", Use: "sig", Alg: "RS256", KID: k.KID,
			N: base64.RawURLEncoding.EncodeToString(pub.N.Bytes()), E: base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())})
	}
	if r.private == nil {
		return nil, ErrConfig
	}
	sort.Slice(r.jwks.Keys, func(i, j int) bool { return r.jwks.Keys[i].KID < r.jwks.Keys[j].KID })
	return r, nil
}

func validIssuer(s string) bool {
	u, err := url.Parse(s)
	return err == nil && len(s) <= 4096 && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && !u.ForceQuery && !strings.Contains(s, "#") && u.Opaque == ""
}

func identifier(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, ch := range s {
		if (ch < 'a' || ch > 'z') && (ch < 'A' || ch > 'Z') && (ch < '0' || ch > '9') && !strings.ContainsRune("._-", ch) {
			return false
		}
	}
	return true
}

func parsePEM(data []byte) (*rsa.PrivateKey, *rsa.PublicKey, error) {
	if len(data) == 0 || len(data) > 64<<10 {
		return nil, nil, ErrConfig
	}
	trimmed := bytes.TrimSpace(data)
	if !bytes.HasPrefix(trimmed, []byte("-----BEGIN ")) || bytes.Count(trimmed, []byte("-----BEGIN ")) != 1 {
		return nil, nil, ErrConfig
	}
	block, rest := pem.Decode(trimmed)
	if block == nil || len(block.Headers) != 0 || len(bytes.TrimSpace(rest)) != 0 {
		return nil, nil, ErrConfig
	}
	var priv *rsa.PrivateKey
	var pub *rsa.PublicKey
	var err error
	switch block.Type {
	case "RSA PRIVATE KEY":
		priv, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	case "PRIVATE KEY":
		var key any
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		priv, _ = key.(*rsa.PrivateKey)
	case "RSA PUBLIC KEY":
		pub, err = x509.ParsePKCS1PublicKey(block.Bytes)
	case "PUBLIC KEY":
		var key any
		key, err = x509.ParsePKIXPublicKey(block.Bytes)
		pub, _ = key.(*rsa.PublicKey)
	default:
		return nil, nil, ErrConfig
	}
	if err != nil || (priv == nil && pub == nil) {
		return nil, nil, ErrConfig
	}
	if priv != nil {
		if priv.Validate() != nil || len(priv.Primes) != 2 {
			return nil, nil, ErrConfig
		}
		pub = &priv.PublicKey
	}
	if pub.N == nil || pub.N.BitLen() < 2048 || pub.N.BitLen() > 8192 || pub.N.Sign() <= 0 || pub.N.Bit(0) == 0 || pub.E < 3 || pub.E%2 == 0 || pub.E > 2147483647 {
		return nil, nil, ErrConfig
	}
	return priv, pub, nil
}

// PublicJWKS returns a detached public snapshot in deterministic kid order.
func (r *Keyring) PublicJWKS() JWKS { return JWKS{Keys: append([]JWK(nil), r.jwks.Keys...)} }

// JWKSJSON returns deterministic public JSON suitable for the JWKS endpoint.
func (r *Keyring) JWKSJSON() []byte { data, _ := json.Marshal(r.jwks); return data }

// Sign validates the pinned issuer, trusted exact audience, subject and times,
// then signs using only ActiveKID with RS256. No algorithm input is accepted.
func (r *Keyring) Sign(c Claims, expectedAudience string) (string, error) {
	w := toWire(c)
	c = fromWire(w)
	now := r.now()
	if !r.validClaims(c, expectedAudience, now) || !c.ExpiresAt.After(now) {
		return "", ErrClaims
	}
	t := jwt.NewWithClaims(jwt.SigningMethodRS256, w)
	t.Header["kid"] = r.active
	signed, err := t.SignedString(r.private)
	if err != nil {
		return "", ErrToken
	}
	return signed, nil
}

// Verify accepts only known kids, RS256, typed claims, exact issuer/audience,
// and valid temporal bounds. It never fetches jku/x5u or selects another algorithm.
func (r *Keyring) Verify(raw, expectedAudience string) (Claims, error) {
	if len(raw) == 0 || len(raw) > 16<<10 || expectedAudience == "" {
		return Claims{}, ErrToken
	}
	// Reject unknown/duplicate claims and headers rather than silently collapsing
	// duplicate JSON members in the JWT library's map decoder.
	if !validTokenJSON(raw) {
		return Claims{}, ErrToken
	}
	w := &wireClaims{}
	now := r.now()
	t, err := jwt.ParseWithClaims(raw, w, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodRS256 || t.Header["typ"] != "JWT" {
			return nil, ErrToken
		}
		kid, ok := t.Header["kid"].(string)
		if !ok {
			return nil, ErrToken
		}
		key, ok := r.public[kid]
		if !ok {
			return nil, ErrToken
		}
		return key, nil
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithIssuer(r.issuer), jwt.WithAudience(expectedAudience), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(func() time.Time { return now }), jwt.WithLeeway(r.skew), jwt.WithStrictDecoding())
	if err != nil || !t.Valid {
		return Claims{}, ErrToken
	}
	c := fromWire(w)
	if !r.validClaims(c, expectedAudience, now) {
		return Claims{}, ErrToken
	}
	return c, nil
}

func (r *Keyring) validClaims(c Claims, audience string, now time.Time) bool {
	if strings.TrimSpace(audience) == "" || len(audience) > 1024 || c.Audience != audience || c.Issuer != r.issuer || strings.TrimSpace(c.Subject) == "" || len(c.Subject) > 255 {
		return false
	}
	if c.IssuedAt.IsZero() || c.ExpiresAt.IsZero() || c.IssuedAt.Unix() <= 0 || c.ExpiresAt.Unix() <= c.IssuedAt.Unix() || c.ExpiresAt.Sub(c.IssuedAt) > r.lifetime {
		return false
	}
	if c.IssuedAt.After(now.Add(r.skew)) || !c.ExpiresAt.After(now.Add(-r.skew)) {
		return false
	}
	if c.NotBefore != nil && (c.NotBefore.IsZero() || c.NotBefore.Unix() <= 0 || c.NotBefore.After(now.Add(r.skew)) || !c.NotBefore.Before(c.ExpiresAt)) {
		return false
	}
	if c.AuthTime != nil && (c.AuthTime.IsZero() || c.AuthTime.Unix() <= 0 || c.AuthTime.After(c.IssuedAt)) {
		return false
	}
	return len(c.Nonce) <= 1024 && len(c.Name) <= 1024 && len(c.PreferredUsername) <= 1024 && len(c.Email) <= 1024 && (c.EmailVerified == nil || c.Email != "")
}

// Wire claims use integer seconds and a string audience independently of the
// JWT library's global TimePrecision/MarshalSingleStringAsArray settings.
func numeric(seconds int64) *jwt.NumericDate {
	return &jwt.NumericDate{Time: time.Unix(seconds, 0).UTC()}
}
func toWire(c Claims) *wireClaims {
	w := &wireClaims{Issuer: c.Issuer, Audience: c.Audience, Subject: c.Subject, IssuedAt: c.IssuedAt.Unix(), ExpiresAt: c.ExpiresAt.Unix(), Nonce: c.Nonce, Name: c.Name, PreferredUsername: c.PreferredUsername, Email: c.Email, EmailVerified: c.EmailVerified}
	if c.NotBefore != nil {
		v := c.NotBefore.Unix()
		w.NotBefore = &v
	}
	if c.AuthTime != nil {
		v := c.AuthTime.Unix()
		w.AuthTime = &v
	}
	return w
}

func fromWire(w *wireClaims) Claims {
	c := Claims{Issuer: w.Issuer, Audience: w.Audience, Subject: w.Subject, IssuedAt: numeric(w.IssuedAt).Time, ExpiresAt: numeric(w.ExpiresAt).Time, Nonce: w.Nonce, Name: w.Name, PreferredUsername: w.PreferredUsername, Email: w.Email, EmailVerified: w.EmailVerified}
	if w.NotBefore != nil {
		v := numeric(*w.NotBefore).Time
		c.NotBefore = &v
	}
	if w.AuthTime != nil {
		v := numeric(*w.AuthTime).Time
		c.AuthTime = &v
	}
	return c
}

func validTokenJSON(raw string) bool {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return false
	}
	for i, allowed := range []string{"alg typ kid", "iss sub aud iat exp nbf nonce auth_time name preferred_username email email_verified"} {
		data, err := base64.RawURLEncoding.Strict().DecodeString(parts[i])
		if err != nil {
			return false
		}
		dec := json.NewDecoder(bytes.NewReader(data))
		start, err := dec.Token()
		if err != nil || start != json.Delim('{') {
			return false
		}
		seen := make(map[string]bool)
		for dec.More() {
			token, err := dec.Token()
			if err != nil {
				return false
			}
			k, ok := token.(string)
			if !ok || seen[k] || !slices.Contains(strings.Fields(allowed), k) {
				return false
			}
			seen[k] = true
			var value json.RawMessage
			if dec.Decode(&value) != nil {
				return false
			}
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim('}') {
			return false
		}
		if dec.More() {
			return false
		}
		var trailing any
		if dec.Decode(&trailing) != io.EOF {
			return false
		}
	}
	return true
}
