package app

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"

	"github.com/calaba/calaba/server/internal/auth"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/httpx"
	"github.com/calaba/calaba/server/internal/redisx"
	"github.com/google/uuid"
)

// Provider limits use stable authenticated identities, shared across HTTP methods
// and IPs. Parsing here only selects a quota: provider handlers remain responsible
// for transactional credentials/CORS/policy validation and never trust this read.
func providerQuotas(d Deps, a *auth.Service) func(string, *http.Request) error {
	ip := redisx.NewRateLimiter(d.Redis, "rl:oauth:token-ip:", 120, 120)
	client := redisx.NewRateLimiter(d.Redis, "rl:oauth:token-client:", 60, 60)
	userinfo := redisx.NewRateLimiter(d.Redis, "rl:oauth:userinfo-client:", 120, 120)
	management := redisx.NewRateLimiter(d.Redis, "rl:oauth:management-user:", 30, 30)
	return func(pattern string, r *http.Request) error {
		if strings.HasSuffix(pattern, "/token") {
			if err := ip.Take(r.Context(), httpx.ClientIP(r.Context())); err != nil {
				return err
			}
			ws, err := uuid.Parse(r.PathValue("workspace"))
			if err != nil {
				return nil
			}
			c, found, err := quotaTokenClient(r, d.DB.Q, ws)
			if err != nil {
				return err
			}
			if !found {
				return nil
			}
			return client.Take(r.Context(), ws.String()+":"+c.ID.String())
		}
		if strings.HasSuffix(pattern, "/userinfo") {
			ws, err := uuid.Parse(r.PathValue("workspace"))
			if err != nil {
				return nil
			}
			raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || !quotaTokenShape(raw, "calab_oa_") || r.URL.RawQuery != "" {
				return nil
			}
			t, err := d.DB.Q.FindOAuthToken(r.Context(), sqlc.FindOAuthTokenParams{WorkspaceID: ws, TokenHash: quotaHash(raw), TokenType: "access"})
			if db.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return httpx.Unavailable(err)
			}
			now, err := d.DB.Q.IdentityDatabaseNow(r.Context())
			if err != nil {
				return httpx.Unavailable(err)
			}
			if t.RevokedAt != nil || !now.Before(t.ExpiresAt) {
				return nil
			}
			g, err := d.DB.Q.GetOAuthGrant(r.Context(), sqlc.GetOAuthGrantParams{WorkspaceID: ws, ID: t.GrantID})
			if db.IsNotFound(err) {
				return nil
			}
			if err != nil {
				return httpx.Unavailable(err)
			}
			if g.ClientID != t.ClientID || g.RevokedAt != nil || !now.Before(g.ExpiresAt) || !now.Before(g.IdleExpiresAt) {
				return nil
			}
			return userinfo.Take(r.Context(), ws.String()+":"+t.ClientID.String())
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if !auth.HasBearer(r) {
				return nil
			} // handlers return their typed 401
			id, err := a.Authenticate(r)
			if err != nil {
				return quotaSessionError(err)
			}
			p, err := a.ResolvePrincipal(r.Context(), id)
			if err != nil {
				return quotaSessionError(err)
			}
			return management.Take(r.Context(), p.UserID.String())
		}
		return nil
	}
}

func quotaTokenClient(r *http.Request, q *sqlc.Queries, ws uuid.UUID) (sqlc.OauthClient, bool, error) {
	invalid := func() (sqlc.OauthClient, bool, error) { return sqlc.OauthClient{}, false, nil }
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || r.URL.RawQuery != "" {
		return invalid()
	}
	// Keep the exact accepted body and do not mutate Form/PostForm. Oversized or
	// ambiguous inputs receive the same protocol error as the provider parser.
	original := r.Body
	if original == nil {
		return invalid()
	}
	raw, err := io.ReadAll(io.LimitReader(original, (16<<10)+1))
	_ = original.Close()
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if err != nil || len(raw) > 16<<10 {
		return sqlc.OauthClient{}, false, httpx.BadRequest("invalid OAuth form")
	}
	f, err := url.ParseQuery(string(raw))
	if err != nil {
		return sqlc.OauthClient{}, false, httpx.BadRequest("invalid OAuth form")
	}
	for _, values := range f {
		if len(values) != 1 || len(values[0]) > 4096 {
			return sqlc.OauthClient{}, false, httpx.BadRequest("invalid OAuth form")
		}
	}
	id := f.Get("client_id")
	user, secret, basic := r.BasicAuth()
	if r.Header.Get("Authorization") != "" && !basic || f.Has("client_secret") || f.Has("client_assertion") || f.Has("client_assertion_type") {
		return invalid()
	}
	if basic {
		user, err = url.QueryUnescape(user)
		if err != nil {
			return invalid()
		}
		secret, err = url.QueryUnescape(secret)
		if err != nil || id != "" {
			return invalid()
		}
		id = user
	}
	c, err := q.FindOAuthClient(r.Context(), sqlc.FindOAuthClientParams{WorkspaceID: ws, ClientID: id})
	if db.IsNotFound(err) {
		return invalid()
	}
	if err != nil {
		return c, false, httpx.Unavailable(err)
	}
	if c.DisabledAt != nil {
		return invalid()
	}
	switch c.AuthMethod {
	case "none":
		if basic || c.ClientType == "confidential_web" {
			return invalid()
		}
	case "client_secret_basic":
		if !basic || c.ClientType != "confidential_web" || !quotaTokenShape(secret, "calab_os_") {
			return invalid()
		}
		keys, err := q.ListOAuthClientSecrets(r.Context(), sqlc.ListOAuthClientSecretsParams{WorkspaceID: ws, ClientID: c.ID})
		if err != nil {
			return c, false, httpx.Unavailable(err)
		}
		match := 0
		hash := quotaHash(secret)
		for _, key := range keys {
			match |= subtle.ConstantTimeCompare(hash, key.SecretHash)
		}
		if match != 1 {
			return invalid()
		}
	default:
		return invalid()
	}
	return c, true, nil
}
func quotaHash(raw string) []byte { v := sha256.Sum256([]byte(raw)); return v[:] }
func quotaTokenShape(raw, prefix string) bool {
	if !strings.HasPrefix(raw, prefix) {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, prefix))
	return err == nil && len(b) == 32 && len(raw) == len(prefix)+43
}

func quotaSessionError(err error) error {
	if errors.Is(err, auth.ErrInvalidToken) || errors.Is(err, auth.ErrSessionRevoked) {
		return httpx.Unauthenticated("invalid session")
	}
	e := httpx.Coded(503, v1.ErrorCode_ERROR_CODE_IDENTITY_DEPENDENCY_UNAVAILABLE, "identity dependency unavailable")
	e.Err = err
	return e
}
